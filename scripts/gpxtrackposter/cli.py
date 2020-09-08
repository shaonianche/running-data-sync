#!/usr/bin/env python
"""Create a variety of poster-style visualizations from GPX data

usage: create_poster.py [-h] [--gpx-dir DIR] [--output FILE]
                        [--language LANGUAGE] [--year YEAR] [--title TITLE]
                        [--athlete NAME] [--special FILE] [--type TYPE]
                        [--background-color COLOR] [--track-color COLOR]
                        [--track-color2 COLOR] [--text-color COLOR]
                        [--special-color COLOR] [--special-color2 COLOR]
                        [--units UNITS] [--clear-cache] [--verbose]
                        [--logfile FILE] [--heatmap-center LAT,LNG]
                        [--heatmap-radius RADIUS_KM] [--circular-rings]
                        [--circular-ring-color COLOR]
                        [--special_distance DISTANCE][--special_distance2 DISTANCE]

optional arguments:
  -h, --help            show this help message and exit
  --gpx-dir DIR         Directory containing GPX files (default: current
                        directory).
  --output FILE         Name of generated SVG image file (default:
                        "poster.svg").
  --language LANGUAGE   Language (default: english).
  --year YEAR           Filter tracks by year; "NUM", "NUM-NUM", "all"
                        (default: all years)
  --title TITLE         Title to display.
  --athlete NAME        Athlete name to display (default: "John Doe").
  --special FILE        Mark track file from the GPX directory as special; use
                        multiple times to mark multiple tracks.
  --type TYPE           Type of poster to create (default: "grid", available:
                        "grid", "calendar", "heatmap", "circular", "github").
  --background-color COLOR
                        Background color of poster (default: "#222222").
  --track-color COLOR   Color of tracks (default: "#4DD2FF").
  --track-color2 COLOR  Secondary color of tracks (default: none).
  --text-color COLOR    Color of text (default: "#FFFFFF").
  --special-color COLOR
                        Special track color (default: "#FFFF00").
  --special-color2 COLOR
                        Secondary color of special tracks (default: none).
  --units UNITS         Distance units; "metric", "imperial" (default:
                        "metric").
  --clear-cache         Clear the track cache.
  --verbose             Verbose logging.
  --logfile FILE

Heatmap Type Options:
  --heatmap-center LAT,LNG
                        Center of the heatmap (default: automatic).
  --heatmap-radius RADIUS_KM
                        Scale the heatmap such that at least a circle with
                        radius=RADIUS_KM is visible (default: automatic).

Circular Type Options:
  --circular-rings      Draw distance rings.
  --circular-ring-color COLOR
                        Color of distance rings.
"""
# Copyright 2016-2019 Florian Pigorsch & Contributors. All rights reserved.
#
# Use of this source code is governed by a MIT-style
# license that can be found in the LICENSE file.

import argparse
import appdirs
import logging
import os
import sys

import poster, track_loader
import grid_drawer, circular_drawer, heatmap_drawer
import github_drawer, calendar_drawer
from exceptions import ParameterError, PosterError


__app_name__ = "create_poster"
__app_author__ = "flopp.net"


def main():
    """Handle command line arguments and call other modules as needed."""

    p = poster.Poster()
    drawers = {
        "grid": grid_drawer.GridDrawer(p),
        "calendar": calendar_drawer.CalendarDrawer(p),
        "heatmap": heatmap_drawer.HeatmapDrawer(p),
        "circular": circular_drawer.CircularDrawer(p),
        "github": github_drawer.GithubDrawer(p),
    }

    args_parser = argparse.ArgumentParser()
    args_parser.add_argument(
        "--gpx-dir",
        dest="gpx_dir",
        metavar="DIR",
        type=str,
        default=".",
        help="Directory containing GPX files (default: current directory).",
    )
    args_parser.add_argument(
        "--output",
        metavar="FILE",
        type=str,
        default="poster.svg",
        help='Name of generated SVG image file (default: "poster.svg").',
    )
    args_parser.add_argument(
        "--language",
        metavar="LANGUAGE",
        type=str,
        default="",
        help="Language (default: english).",
    )
    args_parser.add_argument(
        "--year",
        metavar="YEAR",
        type=str,
        default="all",
        help='Filter tracks by year; "NUM", "NUM-NUM", "all" (default: all years)',
    )
    args_parser.add_argument(
        "--title", metavar="TITLE", type=str, help="Title to display."
    )
    args_parser.add_argument(
        "--athlete",
        metavar="NAME",
        type=str,
        default="John Doe",
        help='Athlete name to display (default: "John Doe").',
    )
    args_parser.add_argument(
        "--special",
        metavar="FILE",
        action="append",
        default=[],
        help="Mark track file from the GPX directory as special; use multiple times to mark "
        "multiple tracks.",
    )
    types = '", "'.join(drawers.keys())
    args_parser.add_argument(
        "--type",
        metavar="TYPE",
        default="grid",
        choices=drawers.keys(),
        help=f'Type of poster to create (default: "grid", available: "{types}").',
    )
    args_parser.add_argument(
        "--background-color",
        dest="background_color",
        metavar="COLOR",
        type=str,
        default="#222222",
        help='Background color of poster (default: "#222222").',
    )
    args_parser.add_argument(
        "--track-color",
        dest="track_color",
        metavar="COLOR",
        type=str,
        default="#4DD2FF",
        help='Color of tracks (default: "#4DD2FF").',
    )
    args_parser.add_argument(
        "--track-color2",
        dest="track_color2",
        metavar="COLOR",
        type=str,
        help="Secondary color of tracks (default: none).",
    )
    args_parser.add_argument(
        "--text-color",
        dest="text_color",
        metavar="COLOR",
        type=str,
        default="#FFFFFF",
        help='Color of text (default: "#FFFFFF").',
    )
    args_parser.add_argument(
        "--special-color",
        dest="special_color",
        metavar="COLOR",
        default="#FFFF00",
        help='Special track color (default: "#FFFF00").',
    )
    args_parser.add_argument(
        "--special-color2",
        dest="special_color2",
        metavar="COLOR",
        help="Secondary color of special tracks (default: none).",
    )
    args_parser.add_argument(
        "--units",
        dest="units",
        metavar="UNITS",
        type=str,
        choices=["metric", "imperial"],
        default="metric",
        help='Distance units; "metric", "imperial" (default: "metric").',
    )
    args_parser.add_argument(
        "--clear-cache",
        dest="clear_cache",
        action="store_true",
        help="Clear the track cache.",
    )
    args_parser.add_argument(
        "--verbose", dest="verbose", action="store_true", help="Verbose logging."
    )
    args_parser.add_argument("--logfile", dest="logfile", metavar="FILE", type=str)
    args_parser.add_argument(
        "--special-distance",
        dest="special_distance",
        metavar="DISTANCE",
        type=float,
        default=10.0,
        help="Special Distance1 by km and color with the special_color",
    )
    args_parser.add_argument(
        "--special-distance2",
        dest="special_distance2",
        metavar="DISTANCE",
        type=float,
        default=20.0,
        help="Special Distance2 by km and corlor with the special_color2",
    )
    args_parser.add_argument(
        "--min-distance",
        dest="min_distance",
        metavar="DISTANCE",
        type=float,
        default=1.0,
        help="min distance by km for track filter",
    )
    args_parser.add_argument(
        "--use-localtime",
        dest="use_localtime",
        action="store_true",
        help="Use utc time or local time",
    )

    for _, drawer in drawers.items():
        drawer.create_args(args_parser)

    args = args_parser.parse_args()

    for _, drawer in drawers.items():
        drawer.fetch_args(args)

    log = logging.getLogger("gpxtrackposter")
    log.setLevel(logging.INFO if args.verbose else logging.ERROR)
    if args.logfile:
        handler = logging.FileHandler(args.logfile)
        log.addHandler(handler)

    loader = track_loader.TrackLoader()
    if args.use_localtime:
        loader.use_local_time = True
    loader.cache_dir = os.path.join(
        appdirs.user_cache_dir(__app_name__, __app_author__), "tracks"
    )
    if not loader.year_range.parse(args.year):
        raise ParameterError(f"Bad year range: {args.year}.")

    loader.special_file_names = args.special
    loader.min_length = args.min_distance * 1000
    if args.clear_cache:
        print("Clearing cache...")
        loader.clear_cache()

    tracks = loader.load_tracks(args.gpx_dir)
    if not tracks:
        if not args.clear_cache:
            print("No tracks found.")
        return

    print(
        f"Creating poster of type {args.type} with {len(tracks)} tracks and storing it in file {args.output}..."
    )
    p.set_language(args.language)
    p.athlete = args.athlete
    if args.title:
        p.title = args.title
    else:
        p.title = p.trans("MY TRACKS")

    p.special_distance = {
        "special_distance": args.special_distance,
        "special_distance2": args.special_distance2,
    }

    p.colors = {
        "background": args.background_color,
        "track": args.track_color,
        "track2": args.track_color2 or args.track_color,
        "special": args.special_color,
        "special2": args.special_color2 or args.special_color,
        "text": args.text_color,
    }
    p.units = args.units
    p.set_tracks(tracks)
    if args.type == "github":
        p.height = 55 + p.years.count() * 43
    p.draw(drawers[args.type], args.output)


if __name__ == "__main__":
    try:
        # generate svg
        main()
    except PosterError as e:
        print(e)
        sys.exit(1)
