"""Publish a verified dependency tree without exposing a partial concurrent installation."""
import errno
import os
from pathlib import Path
import sys

source, target, marker = map(Path, sys.argv[1:])
try:
    os.rename(source, target)
except OSError as error:
    if error.errno not in (errno.EEXIST, errno.ENOTEMPTY) or not (target / marker).is_file():
        raise
