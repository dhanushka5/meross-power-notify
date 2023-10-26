import asyncio
import os
import sys
from mail import send_email
from meross_helpers import find_device
from tracker import Tracker
import logging

RUNNING_DELAY = 180
STOPPED_DELAY = 1800
THRESHOLD = 100
THRESHOLD = 100

logger = logging.getLogger("WM")

async def washing_machine_monitor(manager):
    record = Tracker(sample_size=5, threshold=10,
                     running_detection_points=2, stopped_detection_points=5)
    plug = await find_device(manager, "Synology")
    delay = STOPPED_DELAY
    while(True):
        # Read the electricity power/voltage/current
        instant_consumption = await plug.async_get_instant_metrics()
        message = f"Power consumption is {instant_consumption.power}W"
        record.record(instant_consumption.power)
        print(record.samples[0])

        if instant_consumption.power > THRESHOLD: 
            delay = RUNNING_DELAY

        if (record.turn_off_detected):
            to_emails = os.environ.get('TO_EMAILS').split(',')
            send_email("Washing cycle completed", message, to_emails)
            print("Notified!")
            delay = STOPPED_DELAY
            record.clear()
        
        sys.stdout.flush()
        await asyncio.sleep(delay)