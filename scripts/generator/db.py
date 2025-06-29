import datetime
import random
import ssl
import string

import certifi
import geopy
from geopy.geocoders import Nominatim
from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    Integer,
    String,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()


# random user name 8 letters
def randomword():
    letters = string.ascii_lowercase
    return "".join(random.choice(letters) for i in range(4))


geopy.geocoders.options.default_user_agent = "running-data-sync"
# reverse the location (lat, lon) -> location detail
ctx = ssl.create_default_context(cafile=certifi.where())
geopy.geocoders.options.default_ssl_context = ctx
g = Nominatim(user_agent="running-data-sync", timeout=10)


ACTIVITY_KEYS = [
    "run_id",
    "name",
    "distance",
    "moving_time",
    "type",
    "subtype",
    "start_date",
    "start_date_local",
    "location_country",
    "summary_polyline",
    "average_heartrate",
    "average_speed",
    "elevation_gain",
]


class Activity(Base):
    __tablename__ = "activities"

    run_id = Column(BigInteger, primary_key=True, autoincrement=False)
    name = Column(String)
    distance = Column(Float)
    moving_time = Column(Integer)
    elapsed_time = Column(Integer)
    type = Column(String)
    subtype = Column(String)
    start_date = Column(String)
    start_date_local = Column(String)
    location_country = Column(String)
    summary_polyline = Column(String)
    average_heartrate = Column(Float)
    average_speed = Column(Float)
    elevation_gain = Column(Float)
    streak = None

    def to_dict(self):
        out = {}
        for key in ACTIVITY_KEYS:
            attr = getattr(self, key)
            if isinstance(attr, (datetime.timedelta, datetime.datetime)):
                out[key] = str(attr)
            else:
                out[key] = attr

        if self.streak:
            out["streak"] = self.streak

        return out


def update_or_create_activity(session, run_activity):
    created = False
    try:
        activity = (
            session.query(Activity).filter_by(run_id=int(run_activity.id)).first()
        )

        gain = getattr(
            run_activity,
            "total_elevation_gain",
            getattr(run_activity, "elevation_gain", 0.0),
        )

        # Consolidate common attributes to avoid repetition
        common_data = {
            "name": run_activity.name,
            "distance": float(run_activity.distance),
            "moving_time": run_activity.moving_time.total_seconds(),
            "elapsed_time": run_activity.elapsed_time.total_seconds(),
            "type": run_activity.type,
            "subtype": run_activity.subtype,
            "average_heartrate": run_activity.average_heartrate or 0.0,
            "average_speed": float(run_activity.average_speed),
            "elevation_gain": float(gain or 0.0),
            "summary_polyline": (
                run_activity.map and run_activity.map.summary_polyline or ""
            ),
        }

        if not activity:
            # Logic for creating a new activity
            start_point = run_activity.start_latlng
            location_country = getattr(run_activity, "location_country", "")

            # or China for #176 to fix. This re-geocodes if location is just "China"
            if (not location_country and start_point) or location_country == "China":
                try:
                    location_country = str(
                        g.reverse(
                            f"{start_point.lat},{start_point.lon}",
                            language="zh-CN",
                        )
                    )
                except Exception:
                    # pass if geocoding fails
                    pass

            if not location_country:
                location_country = "中国"

            activity = Activity(
                run_id=run_activity.id,
                start_date=run_activity.start_date,
                start_date_local=run_activity.start_date_local,
                location_country=location_country,
                **common_data,
            )
            session.add(activity)
            created = True
        else:
            # Logic for updating an existing activity
            for key, value in common_data.items():
                setattr(activity, key, value)

    except Exception as e:
        print(f"something wrong with {run_activity.id}")
        print(str(e))

    return created


def add_missing_columns(engine, model):
    inspector = inspect(engine)
    table_name = model.__tablename__
    columns = {col["name"] for col in inspector.get_columns(table_name)}
    missing_columns = []

    for column in model.__table__.columns:
        if column.name not in columns:
            missing_columns.append(column)
    if missing_columns:
        with engine.connect() as conn:
            for column in missing_columns:
                column_type = str(column.type)
                conn.execute(
                    text(
                        f"ALTER TABLE {table_name} "
                        f"ADD COLUMN {column.name} {column_type}"
                    )
                )


def init_db(db_path):
    engine = create_engine(f"duckdb:///{db_path}")
    Base.metadata.create_all(engine)

    # check missing columns
    add_missing_columns(engine, Activity)

    sm = sessionmaker(bind=engine)
    session = sm()
    # apply the changes
    session.commit()
    return session
