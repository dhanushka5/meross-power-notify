
import asyncio
import logging
import os
from meross_iot.http_api import MerossHttpClient
from meross_iot.manager import MerossManager

from config import MEROSS_EMAIL, MEROSS_PASSWORD

logger = logging.getLogger("MEROSS")

async def find_device(manager, name, delay = 60):
    while True:
        await manager.async_device_discovery()
        devices = manager.find_devices(device_name=name)

        if len(devices) >= 1:
            device = devices[0]
            await device.async_update()
            return device

        logger.error(f"Device {name} not found. Retrying after {delay} seconds.")
        await asyncio.sleep(delay)
        logger.info("Retrying async_device_discovery")

async def get_meross():
    email = MEROSS_EMAIL
    password = MEROSS_PASSWORD
    # Setup the HTTP client API from user-password
    http_api_client = await MerossHttpClient.async_from_user_password(email=email, password=password)

    # Setup and start the device manager
    manager = MerossManager(http_client=http_api_client)
    await manager.async_init()
    return manager, http_api_client