#!/usr/bin/python3
"""Keep the image's supported Chromium launch path sandboxed."""
import os
import sys


def checked_arguments(args):
    forbidden = {'--no-sandbox', '--disable-setuid-sandbox', '--disable-namespace-sandbox',
                 '--disable-seccomp-filter-sandbox', '--single-process', '--no-zygote',
                 '--disable-gpu-sandbox'}
    if any(arg.split('=', 1)[0] in forbidden for arg in args):
        raise ValueError('Disabling the Chromium sandbox is not supported')
    return args


if __name__ == '__main__':
    try:
        if os.getuid() == 0:
            raise ValueError('Chromium must run as the non-root desktop user')
        args = checked_arguments(sys.argv[1:])
        os.execv('/usr/bin/chromium', ['chromium', *args])
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
