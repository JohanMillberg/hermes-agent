"""Provider-drift fail-closed guard for cron jobs (#44585).

Background: an UNPINNED cron job follows the global default provider. If that
global state is changed (e.g. a temporary switch to a paid provider like
nous/claude-fable-5), the job would silently inherit it on its next tick and
spend real money — the $7.73 incident.

The fix has two halves:
  - create_job() snapshots the provider resolution WOULD pick at creation into
    job["provider_snapshot"] (only for unpinned, agent-backed jobs).
  - run_job() fails closed when an unpinned job's CURRENTLY-resolved provider
    differs from that snapshot: it skips the run, makes no paid call, and
    delivers a loud actionable error.

These tests exercise the full run_job path (real imports, mocked AIAgent +
resolve_runtime_provider against a temp HERMES_HOME) and the create_job
snapshot capture. They are load-bearing: without the guard, cases (b) call the
agent and "succeed" instead of failing closed.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ensure project root is importable.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from cron.scheduler import _summarize_cron_failure_for_delivery, run_job


def _base_job(**overrides):
    job = {
        "id": "pin-test",
        "name": "pin test",
        "prompt": "hello",
        "model": None,
        "provider": None,
        "provider_snapshot": None,
        "base_url": None,
    }
    job.update(overrides)
    return job


def _run_with_current_provider(job, current_provider, tmp_path):
    """Drive run_job with resolve_runtime_provider pinned to ``current_provider``.

    Returns (success, output, final_response, error, agent_constructed).
    """
    fake_db = MagicMock()
    with patch("cron.scheduler._hermes_home", tmp_path), \
         patch("cron.scheduler._resolve_origin", return_value=None), \
         patch("hermes_cli.env_loader.load_hermes_dotenv"), \
         patch("hermes_cli.env_loader.reset_secret_source_cache"), \
         patch("hermes_state.SessionDB", return_value=fake_db), \
         patch(
             "hermes_cli.runtime_provider.resolve_runtime_provider",
             return_value={
                 "api_key": "test-key",
                 "base_url": "https://example.invalid/v1",
                 "provider": current_provider,
                 "api_mode": "chat_completions",
             },
         ), \
         patch("run_agent.AIAgent") as mock_agent_cls:
        mock_agent = MagicMock()
        mock_agent.run_conversation.return_value = {"final_response": "ok"}
        mock_agent_cls.return_value = mock_agent

        success, output, final_response, error = run_job(job)
        agent_constructed = mock_agent_cls.called

    return success, output, final_response, error, agent_constructed


class TestProviderDriftGuard:
    def test_a_unpinned_snapshot_matches_runs_normally(self, tmp_path):
        """(a) Unpinned job whose snapshot == current provider → runs normally."""
        job = _base_job(provider_snapshot="openrouter")
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider(job, "openrouter", tmp_path)

        assert success is True
        assert error is None
        assert final_response == "ok"
        assert agent_constructed is True

    def test_b_unpinned_snapshot_differs_fails_closed(self, tmp_path):
        """(b) Unpinned job whose snapshot != current provider → fail closed.

        The paid call must NOT be made (AIAgent never constructed), the raw
        error must name both providers, and the delivered summary must tell the
        user to pin.
        """
        job = _base_job(provider_snapshot="openrouter")
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider(job, "nous", tmp_path)

        # Fail closed: no agent constructed, no inference call.
        assert agent_constructed is False
        assert success is False
        assert error is not None

        # Loud + actionable: names both providers, mentions spend + pinning.
        blob = f"{error}\n{output}".lower()
        assert "openrouter" in blob
        assert "nous" in blob
        assert "spend" in blob
        assert "hermes cron edit pin-test --provider <provider> --model <model>" in blob
        assert "cronjob action=update" not in blob
        assert "44585" in blob

        delivered = _summarize_cron_failure_for_delivery(job, error).lower()
        assert "host running hermes" in delivered
        assert "hermes cron edit pin-test --provider <provider> --model <model>" in delivered
        assert "cronjob action=update" not in delivered

    def test_c_no_snapshot_runs_backcompat(self, tmp_path):
        """(c) Pre-existing job with NO provider_snapshot → runs (back-compat).

        Even though the current provider differs from anything, a job without a
        snapshot must behave exactly as before this fix: the guard never engages.
        """
        # A job dict that predates the field entirely (key absent, not None).
        job = _base_job()
        job.pop("provider_snapshot", None)
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider(job, "nous", tmp_path)

        assert success is True
        assert error is None
        assert agent_constructed is True

    def test_c2_snapshot_none_runs_backcompat(self, tmp_path):
        """(c') Job with provider_snapshot explicitly None → runs (back-compat)."""
        job = _base_job(provider_snapshot=None)
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider(job, "nous", tmp_path)

        assert success is True
        assert error is None
        assert agent_constructed is True

    def test_missing_model_guides_to_user_owned_cli(self, tmp_path, monkeypatch):
        """A missing-model failure cannot advertise agent-owned pinning."""
        monkeypatch.delenv("HERMES_MODEL", raising=False)
        success, _output, _final_response, error, agent_constructed = \
            _run_with_current_provider(_base_job(), "openrouter", tmp_path)

        assert success is False
        assert agent_constructed is False
        assert error is not None
        assert "hermes cron edit pin-test --model <name>" in error
        assert "cronjob action=update" not in error

    def test_d_explicitly_pinned_runs_regardless_of_drift(self, tmp_path):
        """(d) Explicitly-pinned job (job["provider"] set) → runs regardless.

        A pinned job does not follow global state, so even a snapshot/current
        mismatch must not skip it. (Snapshot would normally be None for pinned
        jobs, but we set a mismatching one to prove the pin wins.)
        """
        job = _base_job(provider="openrouter", provider_snapshot="anthropic")
        # Current resolution differs from the (stale) snapshot, but the job is
        # pinned, so the guard must not engage.
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider(job, "nous", tmp_path)

        assert success is True
        assert error is None
        assert agent_constructed is True


    def test_explicit_opt_out_allows_provider_and_model_drift(self, tmp_path):
        """The opt-out lets large unpinned fleets track changing defaults."""
        job = _base_job(
            provider_snapshot="old-provider",
            model_snapshot="old-model",
        )
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job,
                "new-provider",
                "new-model",
                tmp_path,
                model_drift_guard=False,
            )

        assert agent_constructed is True
        assert success is True
        assert final_response == "ok"
        assert error is None



class TestCreateJobSnapshot:
    """create_job captures provider_snapshot for unpinned agent jobs only."""

    @staticmethod
    def _isolate_storage(monkeypatch):
        """Patch cron.jobs storage so create_job never touches the real store."""
        import contextlib
        import cron.jobs as jobs

        @contextlib.contextmanager
        def _noop_lock():
            yield

        monkeypatch.setattr(jobs, "_jobs_lock", _noop_lock, raising=True)
        monkeypatch.setattr(jobs, "load_jobs", lambda: [], raising=True)
        monkeypatch.setattr(jobs, "save_jobs", lambda j: None, raising=True)
        return jobs

    def test_unpinned_job_captures_snapshot(self, monkeypatch):
        jobs = self._isolate_storage(monkeypatch)

        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value={"provider": "openrouter"},
        ):
            job = jobs.create_job(prompt="do a thing", schedule="every 1 hour")

        assert job["provider"] is None
        assert job["provider_snapshot"] == "openrouter"

    def test_pinned_job_skips_snapshot(self, monkeypatch):
        jobs = self._isolate_storage(monkeypatch)

        resolver = MagicMock(return_value={"provider": "openrouter"})
        with patch("hermes_cli.runtime_provider.resolve_runtime_provider", resolver):
            job = jobs.create_job(
                prompt="do a thing", schedule="every 1 hour", provider="nous"
            )

        # Explicit provider → pinned → no snapshot needed, and resolution skipped.
        assert job["provider"] == "nous"
        assert job["provider_snapshot"] is None
        resolver.assert_not_called()

    def test_snapshot_resolution_error_fails_open_to_none(self, monkeypatch):
        """If resolution raises at creation, snapshot is None — creation never breaks."""
        jobs = self._isolate_storage(monkeypatch)

        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            side_effect=RuntimeError("no creds"),
        ):
            job = jobs.create_job(prompt="do a thing", schedule="every 1 hour")

        assert job["provider_snapshot"] is None


def _run_with_current_provider_and_model(
    job,
    current_provider,
    current_model,
    tmp_path,
    *,
    model_drift_guard=None,
    cron_model=None,
    cron_model_provider=None,
):
    """Drive run_job with resolved provider pinned and config.yaml model.default
    set to ``current_model`` (the unpinned-model fire-time source)."""
    config_yaml = f"model:\n  default: {current_model}\n"
    cron_lines = []
    if model_drift_guard is not None:
        cron_lines.append(f"  model_drift_guard: {str(model_drift_guard).lower()}")
    if cron_model is not None:
        cron_lines.append(f"  model: {cron_model}")
    if cron_model_provider is not None:
        cron_lines.append(f"  model_provider: {cron_model_provider}")
    if cron_lines:
        config_yaml += "cron:\n" + "\n".join(cron_lines) + "\n"
    (tmp_path / "config.yaml").write_text(config_yaml)
    fake_db = MagicMock()
    with patch("cron.scheduler._hermes_home", tmp_path), \
         patch("cron.scheduler._get_hermes_home", return_value=tmp_path), \
         patch("cron.scheduler._resolve_origin", return_value=None), \
         patch("hermes_cli.env_loader.load_hermes_dotenv"), \
         patch("hermes_cli.env_loader.reset_secret_source_cache"), \
         patch("hermes_state.SessionDB", return_value=fake_db), \
         patch(
             "hermes_cli.runtime_provider.resolve_runtime_provider",
             return_value={
                 "api_key": "test-key",
                 "base_url": "https://example.invalid/v1",
                 "provider": current_provider,
                 "api_mode": "chat_completions",
             },
         ), \
         patch("run_agent.AIAgent") as mock_agent_cls:
        mock_agent = MagicMock()
        mock_agent.run_conversation.return_value = {"final_response": "ok"}
        mock_agent_cls.return_value = mock_agent
        success, output, final_response, error = run_job(job)
        agent_constructed = mock_agent_cls.called
    return success, output, final_response, error, agent_constructed


class TestModelDriftGuard:
    """#44585 C1: model drift on the SAME provider must also fail closed —
    the incident named a model (claude-fable-5), and an unpinned job reads
    config.yaml model.default fresh every tick independently of provider."""

    def test_model_drift_same_provider_fails_closed(self, tmp_path):
        # Provider unchanged (openrouter==openrouter), but the global default
        # MODEL swapped to a premium model since creation → must fail closed.
        job = _base_job(
            provider_snapshot="openrouter",
            model_snapshot="llama-3.3-70b-instruct:free",
        )
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job, "openrouter", "claude-fable-5", tmp_path
            )
        assert agent_constructed is False, "paid call must not be made on model drift"
        assert success is False
        blob = f"{error}\n{output}".lower()
        assert "claude-fable-5" in blob
        assert "llama-3.3-70b-instruct:free" in blob
        assert "44585" in blob


    def test_finite_oneshot_model_drift_explains_that_recreation_is_required(self, tmp_path):
        """A spent one-shot cannot be repaired in place after the guard fires."""
        job = _base_job(
            provider_snapshot="openrouter",
            model_snapshot="old-model",
            schedule={"kind": "once", "run_at": "2030-01-01T00:00:00Z"},
            repeat={"times": 1, "completed": 1},
        )
        success, _output, _final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job, "openrouter", "new-model", tmp_path
            )

        assert success is False
        assert agent_constructed is False
        assert error is not None
        assert "create a new one-shot job" in error.lower()
        assert "cronjob action=update" not in error.lower()

        delivered = _summarize_cron_failure_for_delivery(job, error).lower()
        assert "create a new one-shot job" in delivered
        assert "cronjob action=update" not in delivered

    def test_no_model_snapshot_backcompat(self, tmp_path):
        # Pre-existing job without model_snapshot → no model-drift skip.
        job = _base_job(provider_snapshot="openrouter")  # no model_snapshot key set to a value
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job, "openrouter", "claude-fable-5", tmp_path
            )
        assert agent_constructed is True
        assert success is True


class TestDeadProviderSelfHeal:
    """Auto-migration of stale pinned providers to opencode-go.

    When a job's pinned provider no longer resolves (``invalid_provider`` — the
    signature of a stale job left by a provider rename/switch), the run_job
    fallback path retargets it to opencode-go in-place — but ONLY when the
    configured default is opencode-go, never an arbitrary (potentially paid)
    target. These tests exercise the helper directly; the run_job wiring is
    covered by TestProviderDriftGuard's mock stack.
    """

    @pytest.fixture()
    def tmp_cron_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr("cron.jobs.CRON_DIR", tmp_path / "cron")
        monkeypatch.setattr("cron.jobs.JOBS_FILE", tmp_path / "cron" / "jobs.json")
        monkeypatch.setattr("cron.jobs.OUTPUT_DIR", tmp_path / "cron" / "output")
        return tmp_path

    @staticmethod
    def _cfg(provider="opencode-go", model="gpt-5.6-luna",
             base_url="https://opencode.ai/zen/go/v1",
             self_heal_missing_credentials=False):
        cfg = {"model": {"provider": provider, "default": model, "base_url": base_url}}
        if self_heal_missing_credentials:
            cfg["cron"] = {"self_heal_missing_credentials": True}
        return cfg

    def test_migrates_invalid_provider_to_opencode(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        job = create_job(
            prompt="brief", schedule="every 1h", provider="luna", model="gpt-5.6",
        )
        fake_rt = {
            "provider": "opencode-go", "api_key": "k",
            "base_url": "https://opencode.ai/zen/go/v1", "api_mode": "chat_completions",
        }
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value=fake_rt,
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(), AuthError("unknown provider", code="invalid_provider"),
                job["id"], "brief",
            )
        assert result == (fake_rt, "gpt-5.6-luna")
        healed = get_job(job["id"])
        assert healed["provider"] == "opencode-go"
        assert healed["model"] == "gpt-5.6-luna"
        assert healed["base_url"] == "https://opencode.ai/zen/go/v1"

    def test_skips_missing_credentials_without_opt_in(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        # A known provider with no key (code=None, the default for these errors)
        # is ambiguous — could be a rolled key — so it is NOT auto-healed unless
        # the operator opts in. Left for `cron edit`.
        job = create_job(
            prompt="brief", schedule="every 1h", provider="anthropic",
            model="claude-sonnet-4",
        )
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value={"provider": "opencode-go"},
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(), AuthError("No Anthropic credentials found"),
                job["id"], "brief",
            )
        assert result is None
        assert get_job(job["id"])["provider"] == "anthropic"

    def test_migrates_missing_credentials_when_opted_in(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        job = create_job(
            prompt="brief", schedule="every 1h", provider="anthropic",
            model="claude-sonnet-4",
        )
        fake_rt = {
            "provider": "opencode-go", "api_key": "k",
            "base_url": "https://opencode.ai/zen/go/v1", "api_mode": "chat_completions",
        }
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value=fake_rt,
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(self_heal_missing_credentials=True),
                AuthError("No Anthropic credentials found"),
                job["id"], "brief",
            )
        assert result == (fake_rt, "gpt-5.6-luna")
        healed = get_job(job["id"])
        assert healed["provider"] == "opencode-go"
        assert healed["model"] == "gpt-5.6-luna"

    def test_skips_rate_limited_even_when_opted_in(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        # Transient rate-limiting must never permanently retarget a job, even
        # with the opt-in: the limit clears, but a migration would not.
        job = create_job(
            prompt="brief", schedule="every 1h", provider="anthropic",
            model="claude-sonnet-4",
        )
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value={"provider": "opencode-go"},
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(self_heal_missing_credentials=True),
                AuthError("rate limited", code="codex_rate_limited"),
                job["id"], "brief",
            )
        assert result is None
        assert get_job(job["id"])["provider"] == "anthropic"

    def test_skips_when_default_provider_is_not_opencode(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        job = create_job(
            prompt="brief", schedule="every 1h", provider="luna", model="gpt-5.6",
        )
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value={"provider": "nous"},
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(provider="nous", model="paid-model"),
                AuthError("unknown provider", code="invalid_provider"),
                job["id"], "brief",
            )
        assert result is None
        # Never auto-migrate to a non-opencode (potentially paid) target.
        assert get_job(job["id"])["provider"] == "luna"

    def test_skips_when_opencode_not_resolvable(self, tmp_cron_dir):
        from cron.jobs import create_job, get_job
        from cron.scheduler import _self_heal_dead_provider_to_opencode
        from hermes_cli.auth import AuthError

        job = create_job(
            prompt="brief", schedule="every 1h", provider="luna", model="gpt-5.6",
        )
        with patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            side_effect=AuthError("no opencode", code="invalid_provider"),
        ):
            result = _self_heal_dead_provider_to_opencode(
                job, self._cfg(), AuthError("unknown provider", code="invalid_provider"),
                job["id"], "brief",
            )
        assert result is None
        # Don't migrate to a target that itself can't resolve.
        assert get_job(job["id"])["provider"] == "luna"

class TestCronFleetDefaultModel:
    """cron.model / cron.model_provider — an explicit cron-fleet default is
    NOT drift: unpinned jobs run on it and the #44585 guard stays quiet for
    the covered axis."""

    def test_cron_model_skips_model_drift_guard_and_is_used(self, tmp_path):
        # Snapshot says old free model, global default swapped to a premium
        # model — but cron.model is set, so the job deliberately follows it.
        job = _base_job(
            provider_snapshot="openrouter",
            model_snapshot="llama-3.3-70b-instruct:free",
        )
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job,
                "openrouter",
                "claude-fable-5",
                tmp_path,
                cron_model="qwen-2.5-7b:free",
            )
        assert agent_constructed is True
        assert success is True
        assert final_response == "ok"


    def test_per_job_pin_still_beats_cron_model(self, tmp_path):
        job = _base_job(
            provider_snapshot="openrouter",
            model_snapshot="old-model",
            model="my-pinned-model",
        )
        success, output, final_response, error, agent_constructed = \
            _run_with_current_provider_and_model(
                job,
                "openrouter",
                "claude-fable-5",
                tmp_path,
                cron_model="qwen-2.5-7b:free",
            )
        assert agent_constructed is True
        assert success is True


class TestRuntimeResolutionTargetModel:
    """run_job must resolve the primary provider against the model the job
    will actually run (per-job pin > env > config default), so providers with
    model-specific api_mode routing (e.g. OpenCode Zen/Go) pick the mode for
    the pinned model instead of the stale persisted default."""

    def test_primary_resolution_passes_effective_model(self, tmp_path):
        job = _base_job(model="my-pinned-model", provider="openrouter")
        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return {
                "api_key": "test-key",
                "base_url": "https://example.invalid/v1",
                "provider": "openrouter",
                "api_mode": "chat_completions",
            }

        fake_db = MagicMock()
        with patch("cron.scheduler._hermes_home", tmp_path), \
             patch("cron.scheduler._resolve_origin", return_value=None), \
             patch("hermes_cli.env_loader.load_hermes_dotenv"), \
             patch("hermes_cli.env_loader.reset_secret_source_cache"), \
             patch("hermes_state.SessionDB", return_value=fake_db), \
             patch(
                 "hermes_cli.runtime_provider.resolve_runtime_provider",
                 side_effect=_capture,
             ), \
             patch("run_agent.AIAgent") as mock_agent_cls:
            mock_agent = MagicMock()
            mock_agent.run_conversation.return_value = {"final_response": "ok"}
            mock_agent_cls.return_value = mock_agent
            run_job(job)

        assert captured.get("target_model") == "my-pinned-model"
        assert captured.get("requested") == "openrouter"
