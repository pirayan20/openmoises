default:
    @just --list

# Start OpenMoises in the background.
start:
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{justfile_directory()}}'
    mkdir -p .run
    if [[ -f .run/server.pid ]]; then
        pid=$(<.run/server.pid)
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ "$(ps -p "$pid" -o command=)" == *"$PWD/backend/server.py"* ]]; then
            echo "OpenMoises already running (PID $pid)."
            exit 0
        fi
        rm -f .run/server.pid
    fi
    uv sync
    nohup "$PWD/.venv/bin/python" "$PWD/backend/server.py" > .run/server.log 2>&1 < /dev/null &
    pid=$!
    echo "$pid" > .run/server.pid
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f .run/server.pid
        echo 'Server failed to start. See .run/server.log.' >&2
        exit 1
    fi
    echo "OpenMoises started at http://localhost:8000 (PID $pid). Logs: .run/server.log"

# Stop only the server launched by just start.
stop:
    #!/usr/bin/env bash
    set -euo pipefail
    cd '{{justfile_directory()}}'
    if [[ ! -f .run/server.pid ]]; then
        echo 'No server started by just start.'
        exit 0
    fi
    pid=$(<.run/server.pid)
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ "$(ps -p "$pid" -o command=)" == *"$PWD/backend/server.py"* ]]; then
        kill "$pid"
        echo 'OpenMoises stopped.'
    else
        echo 'Saved server is no longer running. No process stopped.'
    fi
    rm -f .run/server.pid
