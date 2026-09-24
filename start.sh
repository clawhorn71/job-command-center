#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec /usr/bin/ruby server.rb
