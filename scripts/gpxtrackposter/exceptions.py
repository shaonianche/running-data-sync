# Copyright 2016-2019 Florian Pigorsch & Contributors. All rights reserved.
#
# Use of this source code is governed by a MIT-style
# license that can be found in the LICENSE file.

from ..exceptions import ConfigurationError, ParseError, RunningDataSyncError


class PosterError(RunningDataSyncError):
    "Base class for all poster errors"

    pass


class TrackLoadError(ParseError):
    "Something went wrong when loading a track file, we just ignore this file and continue"

    pass


class ParameterError(ConfigurationError):
    "Something's wrong with user supplied parameters"

    pass
