import logger from '../pino';
import { getUpcomingRates } from '../apis/amber';
import { getMerossPlug, setMerossPlug } from '../apis/meross';
import { InterruptableSleep } from '../utils/helpers';
import { ChargeMonitorLastUpdate, ChargeMonitorSettings } from '../models/chargeMonitor';

export class ChargeMonitor {
  private settings: ChargeMonitorSettings = {
    cutoffHour: 15,
    maxPrice: 35,
    stateOfCharge: 85,
    preferredPrice: 18,
  };

  private lastUpdate: Partial<ChargeMonitorLastUpdate> = {};

  private interruptableSleep = new InterruptableSleep();

  setLastUpdate(values: Partial<ChargeMonitorLastUpdate>) {
    if (values.chargingTimes && this.lastUpdate.chargingTimes) {
      values.chargingTimes = [...this.lastUpdate.chargingTimes, ...values.chargingTimes];
    }

    this.lastUpdate = {
      ...this.lastUpdate,
      ...values,
    };
  }

  calculateTimeToNextMinute = (): number => {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const targetMinute = (currentMinute > 30 ? 60 : 30) - currentMinute + 1;
    return targetMinute;
  };

  private getUpcomingCutoff = () => {
    const now = new Date();
    const currentHour = now.getHours();

    const settings = this.getSettings();
    if (currentHour >= settings.cutoffHour) {
      now.setDate(now.getDate() + 1);
    }

    // Set the time to the target hour
    now.setHours(settings.cutoffHour, 0, 0, 0);

    return now.getTime();
  };

  private overrideSettings: Partial<typeof this.settings> & { expireAt: number } = {
    expireAt: 0,
  };

  private overrideSettingsValid() {
    return this.overrideSettings.expireAt >= Date.now();
  }

  getSettings(): typeof this.settings {
    if (this.overrideSettingsValid()) {
      return { ...this.settings, ...this.overrideSettings };
    }

    const now = new Date();
    let cutoff = 15;

    if ((now.getDay() === 5 && now.getHours() >= 15) || (now.getDay() === 6 && now.getHours() < 9)) {
      cutoff = 9;
    } else if ((now.getDay() === 6 && now.getHours() >= 9) || (now.getDay() === 0 && now.getHours() < 10)) {
      cutoff = 10;
    }
    return { ...this.settings, cutoffHour: cutoff };
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  updateOverrideSettings(settings: Partial<typeof this.settings>, updateExpiry = true) {
    this.overrideSettings = {
      ...settings,
      expireAt: updateExpiry ? Date.now() + 24 * 60 * 60 * 1000 : this.overrideSettings.expireAt,
    };

    this.interruptableSleep.interrupt();
    logger.info(`Updated override settings: ${JSON.stringify(this.overrideSettings)}`);
  }

  async shouldCharge() {
    const prices = await getUpcomingRates();
    const cutoff = this.getUpcomingCutoff();
    const settings = this.getSettings();

    const requiredTime = Math.ceil((100 - settings.stateOfCharge + 0.1) / 1.25);

    const validPrices = prices.filter((price) => price.endTimestamp <= cutoff);
    validPrices.sort((a, b) => a.perKwh - b.perKwh);
    const lowestPrices = validPrices.slice(0, requiredTime);

    const priceMax = Math.min(lowestPrices[lowestPrices.length - 1].perKwh + 1, settings.maxPrice);
    if (lowestPrices.length < requiredTime) {
      logger.info(`Not enough prices available to calculate average price.`);
    }
    const currentPrice = prices.find((price) => price.type === 'CurrentInterval');
    if (!currentPrice) {
      throw new Error('No current price found');
    }

    let decision = false;
    if (currentPrice && currentPrice.perKwh < priceMax) {
      decision = true;
    }

    const predictedOnState = validPrices.filter((price) => price.perKwh <= priceMax);
    const predictedStateOfCharge = Math.min(predictedOnState.length * 1.25 + settings.stateOfCharge, 100);
    const predictedAveragePrice =
      predictedOnState.reduce((accumulator, currentValue) => accumulator + currentValue.perKwh, 0) /
      predictedOnState.length;

    this.setLastUpdate({
      lowestPrices,
      priceMax,
      currentPrice,
      cutoff,
      settings,
      charge: decision,
      predictedStateOfCharge,
      predictedAveragePrice,
    });

    return decision;
  }

  async recordPower() {
    const settings = this.getSettings();
    const plug = await getMerossPlug('EV');
    if (plug.power > 1000) {
      const newStateOfCharge = Math.min(settings.stateOfCharge + 1.25, 100);
      logger.info(`Charging is at ${plug.power}. New state of charge is ${newStateOfCharge}`);
      if (this.overrideSettingsValid()) {
        this.updateOverrideSettings({ stateOfCharge: newStateOfCharge }, false);
      }
      return true;
    }
    return false;
  }

  async monitor() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (await this.shouldCharge()) {
          logger.info('Turn on charging');
          await setMerossPlug('EV', true);
          await this.interruptableSleep.sleep(20000);
          const isPluggedIn = await this.recordPower();
          this.setLastUpdate({
            isPluggedIn: isPluggedIn,
            chargingTimes: isPluggedIn
              ? [{ time: Date.now(), price: this.getLastUpdate()?.currentPrice?.perKwh || 0 }]
              : undefined,
          });
        } else {
          logger.info('Turn off charging');
          await setMerossPlug('EV', false);
          this.setLastUpdate({
            isPluggedIn: false,
          });
        }
        const next = this.calculateTimeToNextMinute();
        logger.info(`Wait for ${next} minutes until next check`);
        await this.interruptableSleep.sleep(next * 60 * 1000);
      } catch (e) {
        logger.error(e);
        logger.info(`Error occurred retrying after 1 minute`);
        await this.interruptableSleep.sleep(60000);
      }
    }
  }
}
