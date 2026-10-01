# Start the viewer at login

These templates run the viewer and sync workers together with `codemem serve start --foreground`. They are examples to customize, not files to install unchanged. The service names retain `sync` for compatibility.

## Before installing a template

1. Locate the installed `codemem` launcher with `command -v codemem` and its Node runtime with `command -v node`.
2. Replace `/ABSOLUTE/PATH/TO/codemem` with the installed launcher's absolute path. Ensure the service's `PATH` includes the directory containing Node; a terminal's shell initialization does not run inside a service manager.
3. Use the same user, database, and configuration as your normal codemem installation. Do not run this local viewer as root or expose it to a network as part of autostart setup.
4. Stop any existing viewer before handing ownership to the service manager. Do not run two supervisors for the same viewer.

## macOS

Customize [the launchd template](launchd/com.codemem.sync.plist). Replace `/ABSOLUTE/HOME` in both log paths with your home directory and create its `.codemem` directory before loading the service. launchd does not expand `~` in those strings. Add an `EnvironmentVariables` dictionary with an explicit `PATH` if Node is not available in the service environment.

Install the customized file under `~/Library/LaunchAgents/`. Verify its XML with `plutil -lint` before loading it with your normal launchd workflow.

## Linux

Customize [the systemd user-service template](systemd/codemem-sync.service). `%h` in its configuration path expands to the service user's home directory. Add `Environment=PATH=...` with the full intended search path if the Node runtime is not in the service's default path.

Install the customized unit under `~/.config/systemd/user/`, reload user units, and enable it through your normal systemd workflow. Verify the unit with `systemd-analyze --user verify` where available.

## Verify and recover

Check `codemem status` and the service-manager logs after starting the service. If startup fails, check launcher and Node paths, configuration ownership, and whether another viewer already owns the port. Stop or restart the viewer through the service manager once it owns the foreground process; do not start another background viewer with the CLI.
