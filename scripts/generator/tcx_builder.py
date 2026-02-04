"""TCX file generation utilities."""

import datetime
import time
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring


class TcxBuilderMixin:
    """Mixin class providing TCX file building methods for Generator."""

    def _make_tcx_from_streams(self, activity, streams):
        # TCX XML structure
        root = Element("TrainingCenterDatabase")
        root.attrib = {
            "xmlns": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xsi:schemaLocation": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd",  # noqa: E501
        }

        activities_node = SubElement(root, "Activities")
        activity_node = SubElement(activities_node, "Activity")
        activity_node.set("Sport", activity.type)

        # Activity ID (Start time in ISO format)
        activity_id_node = SubElement(activity_node, "Id")
        activity_id_node.text = activity.start_date.isoformat()

        # Lap
        lap_node = SubElement(activity_node, "Lap")
        lap_node.set("StartTime", activity.start_date.isoformat())

        total_time_seconds = SubElement(lap_node, "TotalTimeSeconds")
        total_time_seconds.text = str(activity.elapsed_time.total_seconds())

        distance_meters = SubElement(lap_node, "DistanceMeters")
        distance_meters.text = str(float(activity.distance))

        if activity.calories:
            calories = SubElement(lap_node, "Calories")
            calories.text = str(int(activity.calories))

        if streams.get("heartrate"):
            avg_hr = SubElement(lap_node, "AverageHeartRateBpm")
            avg_hr_val = SubElement(avg_hr, "Value")
            avg_hr_val.text = str(int(sum(s for s in streams["heartrate"].data) / len(streams["heartrate"].data)))

            max_hr = SubElement(lap_node, "MaximumHeartRateBpm")
            max_hr_val = SubElement(max_hr, "Value")
            max_hr_val.text = str(int(max(streams["heartrate"].data)))

        intensity = SubElement(lap_node, "Intensity")
        intensity.text = "Active"

        trigger_method = SubElement(lap_node, "TriggerMethod")
        trigger_method.text = "Manual"

        track_node = SubElement(lap_node, "Track")

        # Trackpoints
        time_stream = streams.get("time").data if streams.get("time") else []
        latlng_stream = streams.get("latlng").data if streams.get("latlng") else []
        alt_stream = streams.get("altitude").data if streams.get("altitude") else [0] * len(time_stream)
        hr_stream = streams.get("heartrate").data if streams.get("heartrate") else [0] * len(time_stream)

        for i, time_offset in enumerate(time_stream):
            trackpoint_node = SubElement(track_node, "Trackpoint")

            time_node = SubElement(trackpoint_node, "Time")
            time_node.text = (activity.start_date + datetime.timedelta(seconds=time_offset)).isoformat()

            if i < len(latlng_stream):
                position_node = SubElement(trackpoint_node, "Position")
                lat_node = SubElement(position_node, "LatitudeDegrees")
                lat_node.text = str(latlng_stream[i][0])
                lon_node = SubElement(position_node, "LongitudeDegrees")
                lon_node.text = str(latlng_stream[i][1])

            if i < len(alt_stream):
                alt_node = SubElement(trackpoint_node, "AltitudeMeters")
                alt_node.text = str(alt_stream[i])

            if i < len(hr_stream):
                hr_node = SubElement(trackpoint_node, "HeartRateBpm")
                hr_val_node = SubElement(hr_node, "Value")
                hr_val_node.text = str(hr_stream[i])

        # Creator
        creator_node = SubElement(activity_node, "Creator")
        creator_node.set("xsi:type", "Device_t")
        name_node = SubElement(creator_node, "Name")
        name_node.text = "Strava"

        # Pretty print XML
        xml_str = tostring(root, "utf-8")
        parsed_str = minidom.parseString(xml_str)
        return parsed_str.toprettyxml(indent="  ")

    def generate_missing_tcx(self, downloaded_ids):
        self.check_access()

        self.logger.info("Fetching all activities from Strava to check for missing TCX files...")
        activities = self.client.get_activities()  # Fetch all activities

        tcx_files = []

        activities_to_process = [a for a in activities if str(a.id) not in downloaded_ids]

        self.logger.info(f"Found {len(activities_to_process)} new activities to generate TCX for.")

        for activity in activities_to_process:
            try:
                self.logger.info(f"Processing activity: {activity.name} ({activity.id})")
                stream_types = ["time", "latlng", "altitude", "heartrate"]
                streams = self.client.get_activity_streams(activity.id, types=stream_types)

                if not streams.get("latlng") or not streams.get("time"):
                    self.logger.warning(f"Skipping activity {activity.id} due to missing latlng or time streams.")
                    continue

                tcx_content = self._make_tcx_from_streams(activity, streams)
                filename = f"{activity.id}.tcx"
                tcx_files.append((filename, tcx_content))

                # Rate limiting
                time.sleep(2)
            except Exception as e:
                self.logger.error(f"Failed to process activity {activity.id}: {e}", exc_info=True)

        return tcx_files
