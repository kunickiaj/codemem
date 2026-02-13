from typer.testing import CliRunner

from codemem.cli import app

runner = CliRunner()


def test_sync_help_shows_simple_controls() -> None:
    result = runner.invoke(app, ["sync", "--help"])
    assert result.exit_code == 0
    assert "start" in result.stdout
    assert "stop" in result.stdout
    assert "restart" in result.stdout
    assert "\n│ service" not in result.stdout.lower()


def test_root_help_shows_db_namespace() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "db" in result.stdout
    assert "hybrid-eval" in result.stdout


def test_db_help_shows_prune_commands() -> None:
    result = runner.invoke(app, ["db", "--help"])
    assert result.exit_code == 0
    assert "prune-observations" in result.stdout
    assert "prune-memories" in result.stdout
    assert "normalize-projects" in result.stdout
