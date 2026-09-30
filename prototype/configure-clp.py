"""Interactive credential setup; run only after the user approves local persistence.

Never accepts a key through argv/environment or prints it. Creates the sibling
lme-bench/.env exclusively, mode 0600, after verifying Git ignores that path.
"""
import getpass
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
import warnings

TARGET = Path(__file__).resolve().parents[2] / 'lme-bench' / '.env'


def validate_url(value):
    value = value.strip()
    if any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError('URL must not contain whitespace or control characters')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise ValueError('Use an HTTPS base URL without embedded credentials, query or fragment')
    _ = parsed.port  # Reject malformed ports.
    return value.rstrip('/')


def main():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError('Run this helper in an interactive terminal; redirected input is refused')
    if TARGET.exists() or TARGET.is_symlink():
        raise ValueError('Local config already exists; no overwrite performed')
    ignored = subprocess.run(['git', 'check-ignore', '-q', '--', '.env'],
                             cwd=TARGET.parent, capture_output=True)
    tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', '.env'],
                             cwd=TARGET.parent, capture_output=True)
    if ignored.returncode != 0 or tracked.returncode == 0:
        raise ValueError('Config target must be ignored and untracked before setup')
    print('Create local benchmark CLP configuration. The key will not be displayed.')
    base = validate_url(input('CLP HTTPS base URL: '))
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        key = getpass.getpass('CLP API key (hidden): ')
    if not key or key != key.strip() or any(ord(c) < 32 or ord(c) == 127 for c in key):
        raise ValueError('Key must be nonempty, without surrounding whitespace or control characters')
    # O_EXCL refuses an existing file/symlink; mode is owner-only from creation.
    fd = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write('CLP_BASE_URL=' + base + '\nCLP_API_KEY=' + key + '\n')
        output.flush()
        os.fsync(output.fileno())
    key = None
    print('Saved local CLP configuration with owner-only access. No connection was attempted.')


if __name__ == '__main__':
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print('\nCancelled; no connection was attempted.', file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Do not include exceptions/inputs: malformed URL parsing may quote data.
        print('Setup did not complete. Check the terminal, HTTPS URL and local config target; no connection was attempted.', file=sys.stderr)
        sys.exit(1)
