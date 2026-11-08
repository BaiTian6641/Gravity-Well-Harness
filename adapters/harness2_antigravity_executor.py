#!/usr/bin/env python3
"""
Harness² Execution Adapter for Google Antigravity (`AntigravityExecutor`).

Bridges Google Research's `harness2` (https://github.com/google-research/harness2)
with Google Antigravity (via the `google-antigravity` Python SDK, `agy` CLI, or
local deterministic verification probes) while enforcing Snapshot Isolation over
the shared `.harness/` Local Hybrid RAG & Experience Library.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Protocol, Tuple, Union, runtime_checkable


REASONING_DEPTH_PROFILES: Dict[str, Dict[str, Any]] = {
    "eco": {
        "reasoning_depth": "eco",
        "label": "Eco / Token-Saver (~71% fewer tokens)",
        "thinking_budget_tokens": 1024,
        "max_candidate_tokens": 12000,
        "max_probe_steps": 4,
        "rag_top_k": 4,
        "rag_snippet_max_chars": 320,
        "prober_model_tier": "flash_lite",
        "composer_model_tier": "flash",
        "early_stop_on_first_pass": True,
    },
    "balanced": {
        "reasoning_depth": "balanced",
        "label": "Balanced / Adaptive (~53% fewer tokens — Recommended)",
        "thinking_budget_tokens": 2048,
        "max_candidate_tokens": 24000,
        "max_probe_steps": 6,
        "rag_top_k": 6,
        "rag_snippet_max_chars": 500,
        "prober_model_tier": "flash",
        "composer_model_tier": "inherit",
        "early_stop_on_first_pass": True,
    },
    "deep": {
        "reasoning_depth": "deep",
        "label": "Deep Reasoning (Complex Architecture)",
        "thinking_budget_tokens": 8192,
        "max_candidate_tokens": 64000,
        "max_probe_steps": 12,
        "rag_top_k": 10,
        "rag_snippet_max_chars": 1200,
        "prober_model_tier": "inherit",
        "composer_model_tier": "pro",
        "early_stop_on_first_pass": False,
    },
}


@dataclasses.dataclass
class HarnessCandidateSpec:
    """Represents a candidate modification across the 8 Harness² components."""

    candidate_id: str
    hypothesis: str
    front: str = "invariant"  # "invariant" | "domain-specific" | "hybrid"
    model_tier: str = "flash"
    thinking_budget_tokens: int = 2048
    max_steps: int = 6
    system_prompts: str = ""
    rules: List[str] = dataclasses.field(default_factory=list)
    skills: List[str] = dataclasses.field(default_factory=list)
    subagents: List[str] = dataclasses.field(default_factory=list)
    hooks: Dict[str, Any] = dataclasses.field(default_factory=dict)
    tools: List[str] = dataclasses.field(default_factory=list)
    scripts: List[str] = dataclasses.field(default_factory=list)
    plugins: List[str] = dataclasses.field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class ProbeTrajectoryResult:
    """Captures the execution trace, token efficiency, and verification evidence of a single probe."""

    candidate_id: str
    snapshot_id: str
    workspace_mode: str
    passed_verification: bool
    verification_score: float
    steps_executed: int
    tool_errors: int
    prompt_tokens: int
    candidates_tokens: int
    thoughts_tokens: int
    observed_summary: str
    evidence_paths: List[str]
    front: str = "invariant"
    model_tier: str = "flash"
    thinking_budget_tokens: int = 2048
    total_tokens: int = 0
    unoptimized_tokens: int = 16700
    tokens_saved: int = 0
    tokens_saved_pct: float = 0.0
    early_stopped: bool = False
    synthetic: bool = False
    execution_mode: str = "verified"
    verifier_executed: bool = False
    usage_complete: bool = True
    observed_tokens: Optional[int] = None
    artifact_hashes: Dict[str, str] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


class Harness2Library:
    """
    Python interface compatible with Google Research's `harness2/core/library.py`.
    Reads and updates `.harness/library/<domain>/INDEX.md`, `EXPERIENCE.md`, and `harness/manifest.json`.
    """

    def __init__(self, workspace_root: Optional[Path] = None, domain: str = "software-engineering") -> None:
        self.workspace_root = (workspace_root or Path.cwd()).resolve()
        self.domain = domain.lower().replace(" ", "-")
        self.domain_dir = self.workspace_root / ".harness" / "library" / self.domain

    def read_index_markdown(self) -> str:
        idx_path = self.domain_dir / "INDEX.md"
        return idx_path.read_text(encoding="utf-8") if idx_path.exists() else ""

    def list_adopted_harnesses(self) -> List[Dict[str, Any]]:
        harnesses_dir = self.domain_dir / "harnesses"
        if not harnesses_dir.exists():
            return []
        entries: List[Dict[str, Any]] = []
        for task_dir in sorted(harnesses_dir.iterdir()):
            manifest_file = task_dir / "harness" / "manifest.json"
            exp_file = task_dir / "EXPERIENCE.md"
            if manifest_file.exists():
                try:
                    data = json.loads(manifest_file.read_text(encoding="utf-8"))
                    data["experience_path"] = str(exp_file.relative_to(self.workspace_root)).replace("\\", "/")
                    entries.append(data)
                except Exception:
                    pass
        return entries


class _CallableProtocolMeta(type(Protocol)):
    """Allows @runtime_checkable Protocol classes to also instantiate a default concrete implementation when called."""

    def __call__(cls, *args: Any, **kwargs: Any) -> Any:
        concrete = getattr(cls, "_concrete_cls", None)
        if concrete is not None and cls is not concrete:
            return concrete(*args, **kwargs)
        return super().__call__(*args, **kwargs)


@dataclasses.dataclass(frozen=True)
class SurfaceSpec:
    """
    Upstream Harness² `SurfaceSpec` (`harness2/substrate/base.py`, rev `6868817518876de8fd170c6a8354daca273b6191`).
    Describes the editable harness surface and invariant caps of an execution substrate.
    """

    name: str
    always_on: Tuple[str, ...]
    always_on_max: int
    always_on_cap_reason: str
    skill_dir: str
    skill_name_rule: str
    trigger_hint: str
    autotrigger_file: str
    trigger_line: str
    subagent_requires_mode: bool
    plugin_dir: Optional[str]
    hooks_file: Optional[str]
    hook_events: frozenset[str] = dataclasses.field(default_factory=frozenset)
    compile_skill_scripts: bool = False
    reject_empty_always_on: bool = False
    stubs: Tuple[Tuple[str, str], ...] = ()
    editable_components: Tuple[str, ...] = (
        "system_prompts",
        "rules",
        "skills",
        "subagents",
        "hooks",
        "tools",
        "scripts",
        "plugins",
    )
    protected_paths: Tuple[str, ...] = (
        ".git",
        ".harness/snapshots",
        ".harness/index",
        ".harness/receipts",
        "src/secret-vault.mjs",
    )
    required_files: Tuple[str, ...] = (".harness/config.json",)
    validators: Tuple[str, ...] = ("validate_tree", "delivered")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "always_on": list(self.always_on),
            "always_on_max": self.always_on_max,
            "always_on_cap_reason": self.always_on_cap_reason,
            "skill_dir": self.skill_dir,
            "skill_name_rule": self.skill_name_rule,
            "trigger_hint": self.trigger_hint,
            "autotrigger_file": self.autotrigger_file,
            "trigger_line": self.trigger_line,
            "subagent_requires_mode": self.subagent_requires_mode,
            "plugin_dir": self.plugin_dir,
            "hooks_file": self.hooks_file,
            "hook_events": sorted(self.hook_events),
            "compile_skill_scripts": self.compile_skill_scripts,
            "reject_empty_always_on": self.reject_empty_always_on,
            "stubs": [list(s) for s in self.stubs],
            "editable_components": list(self.editable_components),
            "protected_paths": list(self.protected_paths),
            "required_files": list(self.required_files),
            "validators": list(self.validators),
        }

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and key in self.to_dict()

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)

    def keys(self) -> Any:
        return self.to_dict().keys()

    def items(self) -> Any:
        return self.to_dict().items()


@dataclasses.dataclass(frozen=True)
class Install:
    """
    Upstream Harness² `Install` (`harness2/substrate/base.py`).
    Represents a materialised candidate harness tree staged for rollout execution.
    """

    staging_dir: Path
    fingerprint: str
    extras: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        base = {
            "ok": True,
            "staging_dir": str(self.staging_dir),
            "target_dir": str(self.staging_dir),
            "fingerprint": self.fingerprint,
            "source_fingerprint": self.extras.get("source_fingerprint", self.fingerprint),
            "staged_digest": self.fingerprint,
            "materialised_files": list(self.extras.get("materialised_files", [])),
        }
        for k, v in self.extras.items():
            if k not in base:
                base[k] = v
        return base

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and key in self.to_dict()

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)


@dataclasses.dataclass(frozen=True)
class RunRequest:
    """Upstream Harness² `RunRequest` (`harness2/substrate/base.py`)."""

    task_ref: str
    run_ids: Tuple[str, ...]
    timeout: int = 300


@dataclasses.dataclass(frozen=True)
class ChannelSpec:
    """Upstream Harness² `ChannelSpec` (`harness2/core/spec.py`)."""

    name: str = ""
    provider: str = "opencode"
    model: str = "gemini-3-flash"
    description: str = ""
    weight: float = 1.0
    max_bytes: int = 24000


@dataclasses.dataclass(frozen=True)
class BenchPrompts:
    """Upstream Harness² `BenchPrompts` (`harness2/core/spec.py`)."""

    proposer: str = "Propose contrastive candidate harness edits across invariant and domain-specific fronts."
    composer: str = "Compose the winning harness from observed trajectory contrasts and verified deliverables."
    reflector: str = "Record empirical lessons with 5-part provenance and evaluation receipts."
    domain_hint: str = "Apply verified cues from .harness/library/<domain>/INDEX.md under frozen snapshot isolation."
    evaluator_notes: str = "Verify delivered artifacts independently of assistant prose."
    proposer_hint: str = "Focus on bounded thinking budgets and deterministic verification checks."
    proposer_footer: str = "Emit valid candidate harness trees respecting SurfaceSpec protected_paths."
    composer_header: str = "Evaluate behavioral contrasts across K candidate probes."
    reflector_header: str = "Distill reusable conditional cues and failure modes."
    proposer_Hint: str = "Focus on bounded thinking budgets and deterministic verification checks."
    proposer_Footer: str = "Emit valid candidate harness trees respecting SurfaceSpec protected_paths."
    composer_Header: str = "Evaluate behavioral contrasts across K candidate probes."
    reflector_Header: str = "Distill reusable conditional cues and failure modes."


@dataclasses.dataclass(frozen=True)
class BenchSpec:
    """Upstream Harness² `BenchSpec` (`harness2/core/spec.py`)."""

    name: str
    install_mode: str = "full_tree"
    domains: Tuple[str, ...] = ("software-engineering",)
    channels: Tuple[ChannelSpec, ...] = ()
    prompts: BenchPrompts = dataclasses.field(default_factory=BenchPrompts)
    max_candidates: int = 2
    default_timeout: int = 300
    split: str = "all"
    metadata: Mapping[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass(frozen=True)
class RunView:
    """Upstream Harness² `RunView` (`harness2/core/spec.py`)."""

    run_id: str
    task_id: str
    run_dir: Path = dataclasses.field(default_factory=lambda: Path("."))
    delivered: bool = False
    trajectory: str = ""
    deliverable_files: Mapping[str, str] = dataclasses.field(default_factory=dict)
    deliverable_text: str = ""
    score: Optional[Mapping[str, Any]] = None
    passed: bool = False
    metrics: Mapping[str, float] = dataclasses.field(default_factory=dict)


def resolve_prompts(bench: Any) -> BenchPrompts:
    """Upstream Harness² `resolve_prompts(bench)` helper (`harness2/core/spec.py`)."""
    spec = getattr(bench, "spec", bench)
    prompts = getattr(spec, "prompts", None)
    if isinstance(prompts, BenchPrompts):
        return prompts
    if isinstance(prompts, Mapping):
        p_hint = str(prompts.get("proposer_hint") or prompts.get("proposer_Hint") or "")
        p_foot = str(prompts.get("proposer_footer") or prompts.get("proposer_Footer") or "")
        c_head = str(prompts.get("composer_header") or prompts.get("composer_Header") or "")
        r_head = str(prompts.get("reflector_header") or prompts.get("reflector_Header") or "")
        return BenchPrompts(
            proposer=str(prompts.get("proposer", "")),
            composer=str(prompts.get("composer", "")),
            reflector=str(prompts.get("reflector", "")),
            domain_hint=str(prompts.get("domain_hint", "")),
            evaluator_notes=str(prompts.get("evaluator_notes", "")),
            proposer_hint=p_hint,
            proposer_footer=p_foot,
            composer_header=c_head,
            reflector_header=r_head,
            proposer_Hint=p_hint,
            proposer_Footer=p_foot,
            composer_Header=c_head,
            reflector_Header=r_head,
        )
    return BenchPrompts()


class TrajectoryReport(str):
    """
    String trajectory representation satisfying `Substrate.read_trajectory(...) -> str`
    while also supporting structured dict access (`report["events"]`, `report["actions"]`, etc.).
    """

    def __new__(cls, text: str, meta: Optional[Dict[str, Any]] = None) -> "TrajectoryReport":
        obj = super().__new__(cls, text)
        obj._meta = dict(meta or {})
        return obj

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, (int, slice)):
            return super().__getitem__(key)
        return self._meta[key]

    def __contains__(self, key: Any) -> bool:
        if isinstance(key, str) and key in self._meta:
            return True
        return super().__contains__(key)

    def get(self, key: str, default: Any = None) -> Any:
        return self._meta.get(key, default)

    def keys(self) -> Any:
        return self._meta.keys()

    def items(self) -> Any:
        return self._meta.items()

    def to_dict(self) -> Dict[str, Any]:
        return dict(self._meta)


@runtime_checkable
class SubstrateLike(Protocol):
    """Upstream Harness² `SubstrateLike` protocol (`harness2/core/spec.py`)."""

    name: str

    def surface(self) -> SurfaceSpec:
        ...


@runtime_checkable
class Substrate(Protocol, metaclass=_CallableProtocolMeta):
    """
    Upstream Harness² `Substrate` protocol (`harness2/substrate/base.py`, rev `6868817518876de8fd170c6a8354daca273b6191`).
    Defines the five execution seams: `surface()`, `materialise()`, `execute()`,
    `read_trajectory()`, and `preflight()`.
    """

    name: str

    def surface(self) -> SurfaceSpec:
        ...

    def materialise(
        self,
        tree_dir: Path,
        spec: Any = None,
        ctx: Optional[Mapping[str, str]] = None,
    ) -> Install:
        ...

    def execute(
        self,
        task_ref: Any,
        install: Optional[Install] = None,
        run_ids: Optional[List[str]] = None,
        timeout: int = 300,
    ) -> Any:
        ...

    def read_trajectory(
        self,
        stream_path: Path,
        *,
        obs_trunc: int = 2000,
        max_chars: int = 24000,
        args_trunc: int = 400,
    ) -> str:
        ...

    def preflight(self) -> Any:
        ...


@runtime_checkable
class BenchmarkAdapter(Protocol, metaclass=_CallableProtocolMeta):
    """
    Upstream Harness² `BenchmarkAdapter` protocol (`harness2/core/spec.py`, rev `6868817518876de8fd170c6a8354daca273b6191`).
    Independently verifies artifact delivery, candidate tree invariants, and post-selection scoring.
    """

    spec: BenchSpec
    substrate: SubstrateLike

    def tasks(self, split: str = "all") -> List[str]:
        ...

    def domain_of(self, task_id: str) -> str:
        ...

    def task_prompt(self, task_id: str) -> str:
        ...

    def task_files(self, task_id: str) -> Optional[Path]:
        ...

    def execute(
        self,
        task_id: str,
        harness_dir: Optional[Path],
        run_id: str,
        *,
        timeout: Optional[int] = None,
    ) -> Path:
        ...

    def delivered(self, run_dir: Path) -> bool:
        ...

    def trajectory(self, run_dir: Path, *, obs_trunc: int = 2000) -> str:
        ...

    def deliverable_files(self, run_dir: Path) -> Dict[str, str]:
        ...

    def deliverable_text(self, run_dir: Path) -> str:
        ...

    def base_harness(self) -> Path:
        ...

    def validate_tree(self, tree: Dict[str, str]) -> None:
        ...

    def score(self, run_dir: Path, task_id: str = "") -> Optional[Dict[str, Any]]:
        ...


class AntigravitySubstrate:
    """Concrete Antigravity implementation of the upstream `Substrate` and `SubstrateLike` protocols."""

    name: str = "antigravity"

    def __init__(self, workspace_root: Optional[Union[str, Path]] = None) -> None:
        self.workspace_root = Path(workspace_root or Path.cwd()).resolve()
        self.substrate = "auto"

    def surface(self) -> SurfaceSpec:
        return SurfaceSpec(
            name=self.name,
            always_on=(
                ".agents/rules/gravity-well-default.md",
                "plugin/harness-ide/rules/AGENTS.md",
            ),
            always_on_max=32768,
            always_on_cap_reason="Keep always-on system rules bounded to preserve working context window.",
            skill_dir="plugin/harness-ide/skills",
            skill_name_rule="^[a-z0-9][a-z0-9_-]{1,63}$",
            trigger_hint="Activate when task domain or workflow matches the skill description.",
            autotrigger_file="AGENTS.md",
            trigger_line="Read matching SKILL.md before executing domain workflow.",
            subagent_requires_mode=True,
            plugin_dir="plugin/harness-ide",
            hooks_file="plugin/harness-ide/hooks/hooks.json",
            hook_events=frozenset({"SessionStart", "PreInvocation", "PostToolUse"}),
            compile_skill_scripts=False,
            reject_empty_always_on=True,
            stubs=(),
        )

    def preflight(self) -> Dict[str, Any]:
        """Checks runtime, credentials, policy, and dependencies without starting model generation."""
        node_ok = shutil.which("node") is not None
        has_api_key = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("DEEPSEEK_API_KEY"))
        sdk_installed = False
        try:
            import importlib.util

            sdk_installed = importlib.util.find_spec("google.antigravity") is not None
        except Exception:
            sdk_installed = False

        sdk_required = getattr(self, "substrate", "auto") == "antigravity-sdk"
        ready = node_ok and (not sdk_required or (sdk_installed and has_api_key))
        return {
            "ok": ready,
            "substrate": getattr(self, "substrate", "auto"),
            "workspace_root": str(self.workspace_root),
            "node_available": node_ok,
            "sdk_installed": sdk_installed,
            "has_credentials": has_api_key,
            "started_generation": False,
        }

    def materialise(
        self,
        tree_dir: Any,
        spec: Any = None,
        ctx: Optional[Mapping[str, str]] = None,
    ) -> Install:
        """
        Stages a candidate harness tree or spec into an isolated runtime directory with digests.
        Supports both upstream `materialise(tree_dir: Path, spec, ctx) -> Install`
        and `materialise(candidate_tree, target_dir) -> Install`.
        """
        if isinstance(spec, (str, Path)):
            target_path = Path(spec).resolve()
        else:
            staging_root = (self.workspace_root / ".harness" / "runtime" / "staging").resolve()
            staging_root.mkdir(parents=True, exist_ok=True)
            seed = hashlib.sha256(f"{tree_dir}:{datetime.datetime.now(datetime.timezone.utc).isoformat()}".encode("utf-8")).hexdigest()[:12]
            target_path = (staging_root / f"stage-{seed}").resolve()

        target_path.mkdir(parents=True, exist_ok=True)
        materialised_files: List[str] = []
        source_hasher = hashlib.sha256()
        protected_set = set(self.surface().protected_paths)
        ctx_map: Dict[str, str] = {str(k): str(v) for k, v in (ctx or {}).items()} if isinstance(ctx, Mapping) else {}

        def _interpolate_bytes(raw_b: bytes) -> bytes:
            if not ctx_map:
                return raw_b
            try:
                text = raw_b.decode("utf-8")
                for ck, cv in ctx_map.items():
                    text = text.replace(f"{{{{{ck}}}}}", cv).replace(f"${{{ck}}}", cv)
                return text.encode("utf-8")
            except UnicodeDecodeError:
                return raw_b

        if isinstance(tree_dir, (str, Path)) and Path(tree_dir).exists():
            src_path = Path(tree_dir).resolve()
            if src_path.is_dir():
                for src_file in sorted(src_path.rglob("*")):
                    if src_file.is_dir():
                        continue
                    rel = src_file.relative_to(src_path)
                    rel_posix = str(rel).replace("\\", "/")
                    if rel_posix.startswith(".git/") or rel_posix in protected_set:
                        continue
                    raw_bytes = _interpolate_bytes(src_file.read_bytes())
                    source_hasher.update(rel_posix.encode("utf-8"))
                    source_hasher.update(raw_bytes)
                    dest_file = (target_path / rel).resolve()
                    if not str(dest_file).startswith(str(target_path)):
                        raise ValueError(f"Path traversal rejected in materialise: {rel_posix}")
                    dest_file.parent.mkdir(parents=True, exist_ok=True)
                    dest_file.write_bytes(raw_bytes)
                    materialised_files.append(rel_posix)
            else:
                raw_bytes = _interpolate_bytes(src_path.read_bytes())
                source_hasher.update(raw_bytes)
                dest_file = target_path / src_path.name
                dest_file.write_bytes(raw_bytes)
                materialised_files.append(src_path.name)
        elif isinstance(tree_dir, Mapping) and all(isinstance(k, str) and isinstance(v, str) for k, v in tree_dir.items()):
            for rel_key in sorted(tree_dir.keys()):
                rel_posix = rel_key.replace("\\", "/").strip()
                while rel_posix.startswith("./"):
                    rel_posix = rel_posix[2:]
                if ".." in Path(rel_posix).parts or rel_posix.startswith("/"):
                    raise ValueError(f"Path traversal rejected in materialise: {rel_key}")
                if rel_posix == ".git" or rel_posix.startswith(".git/") or any(rel_posix == p or rel_posix.startswith(p + "/") for p in protected_set):
                    raise ValueError(f"Protected path rejected in materialise: {rel_posix}")
                raw_bytes = _interpolate_bytes(tree_dir[rel_key].encode("utf-8"))
                source_hasher.update(rel_posix.encode("utf-8"))
                source_hasher.update(raw_bytes)
                dest_file = (target_path / rel_posix).resolve()
                if not str(dest_file).startswith(str(target_path)):
                    raise ValueError(f"Path traversal rejected in materialise: {rel_posix}")
                dest_file.parent.mkdir(parents=True, exist_ok=True)
                dest_file.write_bytes(raw_bytes)
                materialised_files.append(rel_posix)
        else:
            spec_dict = (
                tree_dir.to_dict()
                if hasattr(tree_dir, "to_dict")
                else (dict(tree_dir) if isinstance(tree_dir, Mapping) else {"raw": str(tree_dir)})
            )
            serialized = _interpolate_bytes(json.dumps(spec_dict, sort_keys=True, indent=2).encode("utf-8"))
            source_hasher.update(serialized)
            manifest_dir = target_path / "harness"
            manifest_dir.mkdir(parents=True, exist_ok=True)
            manifest_file = manifest_dir / "manifest.json"
            manifest_file.write_bytes(serialized)
            materialised_files.append("harness/manifest.json")

        if ctx_map:
            ctx_bytes = json.dumps(ctx_map, sort_keys=True, indent=2).encode("utf-8")
            (target_path / ".harness-stage-context.json").write_bytes(ctx_bytes)
            materialised_files.append(".harness-stage-context.json")

        staged_hasher = hashlib.sha256()
        for f_rel in sorted(materialised_files):
            staged_hasher.update(f_rel.encode("utf-8"))
            staged_hasher.update((target_path / f_rel).read_bytes())

        source_fp = source_hasher.hexdigest()
        staged_fp = staged_hasher.hexdigest()
        return Install(
            staging_dir=target_path,
            fingerprint=staged_fp,
            extras={
                "ok": True,
                "target_dir": str(target_path),
                "source_fingerprint": source_fp,
                "staged_digest": staged_fp,
                "materialised_files": materialised_files,
                "ctx": ctx_map,
            },
        )

    def _resolve_candidate_command(self, candidate_dir: Optional[Path]) -> Optional[Union[str, List[str]]]:
        if candidate_dir is None or not candidate_dir.exists() or not candidate_dir.is_dir():
            return None
        for manifest_rel in ("harness/manifest.json", "manifest.json", "candidate_spec.json"):
            m_path = candidate_dir / manifest_rel
            if m_path.exists() and m_path.is_file():
                try:
                    m_data = json.loads(m_path.read_text(encoding="utf-8"))
                    if isinstance(m_data, dict):
                        cmd_val = m_data.get("command") or m_data.get("entrypoint")
                        if isinstance(cmd_val, (str, list)) and cmd_val:
                            return cmd_val
                except Exception:
                    pass
        for script_rel in ("run.py", "scripts/run.py", "harness/run.py"):
            s_path = candidate_dir / script_rel
            if s_path.exists() and s_path.is_file():
                return [sys.executable, str(s_path)]
        for node_rel in ("run.mjs", "run.js", "scripts/run.mjs", "scripts/run.js"):
            n_path = candidate_dir / node_rel
            if n_path.exists() and n_path.is_file():
                return ["node", str(n_path)]
        return None

    def _check_task_stop_state(self, task_id: str) -> Optional[Dict[str, Any]]:
        safe_id = re.sub(r"[^a-zA-Z0-9._-]", "-", str(task_id or "").strip())[:80]
        if not safe_id:
            return None
        task_dir = self.workspace_root / ".harness" / "tasks" / safe_id
        for fname in ("state.json", "progress-guard.json"):
            fpath = task_dir / fname
            if fpath.exists():
                try:
                    data = json.loads(fpath.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and (
                        data.get("status") == "escalated_focused_restart"
                        or data.get("shouldStopRetryLoop") is True
                    ):
                        return {
                            "ok": False,
                            "status": "escalated_stop",
                            "error": "ESCALATED_NO_PROGRESS_STOP",
                            "task_id": task_id,
                            "passed_verification": False,
                            "verification_score": 0.0,
                            "recordedExperience": None,
                        }
                except Exception:
                    pass
        return None

    def _execute_single_run(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        task_id_str = str(spec.get("task_id") or spec.get("task_ref") or "")
        stop_check = self._check_task_stop_state(task_id_str)
        if stop_check is not None:
            return stop_check

        run_id = str(
            spec.get("run_id")
            or spec.get("candidate_id")
            or f"run-{int(datetime.datetime.now(datetime.timezone.utc).timestamp())}"
        )
        run_dir_raw = spec.get("run_dir")
        if run_dir_raw:
            run_dir_path = Path(run_dir_raw).resolve()
        else:
            run_dir_path = (self.workspace_root / ".harness" / "runtime" / "runs" / run_id).resolve()
        run_dir_path.mkdir(parents=True, exist_ok=True)
        deliverables_dir = run_dir_path / "deliverables"
        deliverables_dir.mkdir(parents=True, exist_ok=True)

        required_files = list(spec.get("required_files") or spec.get("requiredArtifacts") or [])
        candidate_dir_raw = spec.get("install_dir") or spec.get("harness_dir")
        candidate_dir_path = Path(candidate_dir_raw).resolve() if candidate_dir_raw else None
        command = spec.get("command") or self._resolve_candidate_command(candidate_dir_path)
        validator_cmd = spec.get("validator_cmd") or spec.get("verifier_command")
        timeout_s = float(spec.get("timeout_s") or spec.get("timeout") or 30.0)
        events: List[Dict[str, Any]] = []
        errors: List[str] = []
        cmd_ok = False
        executed = False

        if command:
            try:
                run_env = dict(os.environ)
                run_env["HARNESS_RUN_DIR"] = str(run_dir_path)
                run_env["HARNESS_DELIVERABLES_DIR"] = str(deliverables_dir)
                run_env["HARNESS_TASK_ID"] = task_id_str
                if candidate_dir_path:
                    run_env["HARNESS_CANDIDATE_DIR"] = str(candidate_dir_path)
                proc = subprocess.run(
                    command if isinstance(command, list) else str(command),
                    shell=isinstance(command, str),
                    cwd=str(run_dir_path),
                    env=run_env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=timeout_s,
                    check=False,
                )
                executed = True
                cmd_ok = proc.returncode == 0
                events.append(
                    {
                        "type": "action",
                        "step": 1,
                        "action": "run_command",
                        "command": command,
                        "returncode": proc.returncode,
                    }
                )
                events.append(
                    {
                        "type": "observation",
                        "step": 1,
                        "stdout": (proc.stdout or "")[:2000],
                        "stderr": (proc.stderr or "")[:2000],
                    }
                )
                if proc.returncode != 0:
                    errors.append(f"COMMAND_EXIT_{proc.returncode}")
                    events.append({"type": "error", "step": 1, "error": f"EXIT_{proc.returncode}"})
            except subprocess.TimeoutExpired:
                executed = True
                cmd_ok = False
                errors.append("EXECUTION_TIMEOUT")
                events.append({"type": "error", "step": 1, "error": "EXECUTION_TIMEOUT"})
        else:
            errors.append("NO_EXECUTION_COMMAND_OR_PROVIDER")
            events.append(
                {
                    "type": "error",
                    "step": 1,
                    "error": "NO_EXECUTION_COMMAND_OR_PROVIDER",
                }
            )

        # Collect agent-produced files strictly inside run_dir_path
        metadata_names = {
            "receipt.json",
            "trajectory.json",
            "manifest.json",
            "candidate_spec.json",
            "assistant_response.md",
            ".harness-stage-context.json",
        }
        produced_files: List[str] = []
        artifact_hashes: Dict[str, str] = {}
        for f_item in sorted(run_dir_path.rglob("*")):
            if not f_item.is_file() or f_item.name in metadata_names:
                continue
            if f_item.stat().st_size > 0:
                rel_p = str(f_item.relative_to(run_dir_path)).replace("\\", "/")
                produced_files.append(rel_p)
                try:
                    digest_hex = hashlib.sha256(f_item.read_bytes()).hexdigest()
                    if str(f_item).startswith(str(self.workspace_root)):
                        ws_rel = str(f_item.relative_to(self.workspace_root)).replace("\\", "/")
                        artifact_hashes[ws_rel] = digest_hex
                    else:
                        artifact_hashes[rel_p] = digest_hex
                except Exception:
                    pass

        missing_files: List[str] = []
        for req_f in required_files:
            cand_a = (deliverables_dir / req_f).resolve()
            cand_b = (run_dir_path / req_f).resolve()
            ok_a = (
                str(cand_a).startswith(str(run_dir_path))
                and cand_a.exists()
                and cand_a.is_file()
                and cand_a.stat().st_size > 0
            )
            ok_b = (
                str(cand_b).startswith(str(run_dir_path))
                and cand_b.exists()
                and cand_b.is_file()
                and cand_b.stat().st_size > 0
            )
            if not (ok_a or ok_b):
                missing_files.append(str(req_f))
                errors.append(f"MISSING_REQUIRED_FILE:{req_f}")
                events.append({"type": "error", "step": 2, "error": f"MISSING_REQUIRED_FILE:{req_f}"})

        has_deliverables = len(missing_files) == 0 and (len(required_files) > 0 or len(produced_files) > 0)
        verifier_executed = False
        validator_ok = False

        if validator_cmd and executed and cmd_ok and has_deliverables:
            try:
                val_env = dict(os.environ)
                val_env["HARNESS_RUN_DIR"] = str(run_dir_path)
                val_env["HARNESS_DELIVERABLES_DIR"] = str(deliverables_dir)
                val_env["HARNESS_TASK_ID"] = task_id_str
                v_proc = subprocess.run(
                    validator_cmd if isinstance(validator_cmd, list) else str(validator_cmd),
                    shell=isinstance(validator_cmd, str),
                    cwd=str(run_dir_path),
                    env=val_env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=timeout_s,
                    check=False,
                )
                verifier_executed = True
                validator_ok = v_proc.returncode == 0
                events.append(
                    {
                        "type": "action",
                        "step": 2,
                        "action": "run_validator",
                        "command": validator_cmd,
                        "returncode": v_proc.returncode,
                    }
                )
                if not validator_ok:
                    errors.append(f"VALIDATOR_EXIT_{v_proc.returncode}")
            except subprocess.TimeoutExpired:
                verifier_executed = True
                validator_ok = False
                errors.append("VALIDATOR_TIMEOUT")

        if verifier_executed:
            passed = executed and cmd_ok and has_deliverables and validator_ok
            run_status = "succeeded" if passed else "failed"
        else:
            passed = False
            run_status = "delivered_unverified" if (executed and cmd_ok and has_deliverables) else "failed"

        traj_path = run_dir_path / "trajectory.json"
        receipt_path = run_dir_path / "receipt.json"
        traj_payload = {
            "run_id": run_id,
            "run_dir": str(run_dir_path),
            "executed": executed,
            "events": events,
            "errors": errors,
        }
        receipt_payload = {
            "run_id": run_id,
            "task_id": task_id_str,
            "run_dir": str(run_dir_path),
            "executed": executed,
            "verifier_executed": verifier_executed,
            "synthetic": False,
            "status": run_status,
            "passed_verification": passed,
            "verification_score": 1.0 if passed else 0.0,
            "delivered": has_deliverables,
            "delivered_files": produced_files,
            "artifact_hashes": artifact_hashes,
            "missing_files": missing_files,
            "errors": errors,
            "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        traj_path.write_text(json.dumps(traj_payload, indent=2), encoding="utf-8")
        receipt_path.write_text(json.dumps(receipt_payload, indent=2), encoding="utf-8")

        return {
            "ok": passed,
            "executed": executed,
            "verifier_executed": verifier_executed,
            "status": run_status,
            "passed_verification": passed,
            "verification_score": 1.0 if passed else 0.0,
            "run_id": run_id,
            "run_dir": str(run_dir_path),
            "trajectory_path": str(traj_path),
            "receipt_path": str(receipt_path),
            "delivered": has_deliverables,
            "delivered_files": produced_files,
            "artifact_hashes": artifact_hashes,
            "missing_files": missing_files,
            "steps_executed": len([e for e in events if e.get("type") == "action"]),
            "errors": errors,
        }

    def execute(
        self,
        task_ref: Any,
        install: Optional[Install] = None,
        run_ids: Optional[List[str]] = None,
        timeout: int = 300,
    ) -> Any:
        """
        Executes candidate rollout(s).
        - Upstream protocol call `execute(task_ref: str, install: Install, run_ids: list[str], timeout: int) -> list[Path]`
          returns a list of `Path` run directories.
        - Direct dict/spec call `execute(run_spec: dict) -> dict` returns the structured execution summary dict.
        """
        if isinstance(task_ref, dict):
            spec = dict(task_ref)
            if install is not None and getattr(install, "staging_dir", None) is not None:
                spec.setdefault("install_dir", str(getattr(install, "staging_dir")))
            return self._execute_single_run(spec)

        if install is not None or run_ids is not None or isinstance(task_ref, RunRequest):
            if isinstance(task_ref, RunRequest):
                req_task = task_ref.task_ref
                req_ids = list(task_ref.run_ids)
                req_timeout = task_ref.timeout
            else:
                req_task = str(task_ref)
                req_ids = list(run_ids or ["run-0"])
                req_timeout = int(timeout)

            staging_dir_val = getattr(install, "staging_dir", None) if install is not None else None
            out_paths: List[Path] = []
            for rid in req_ids:
                res = self._execute_single_run(
                    {
                        "task_ref": req_task,
                        "task_id": req_task,
                        "run_id": rid,
                        "timeout_s": req_timeout,
                        "install_dir": str(staging_dir_val) if staging_dir_val is not None else None,
                    }
                )
                out_paths.append(Path(res["run_dir"]))
            return out_paths

        spec = getattr(task_ref, "__dict__", {"task_ref": str(task_ref)})
        return self._execute_single_run(spec)

    def read_trajectory(
        self,
        stream_path: Union[str, Path],
        *,
        obs_trunc: int = 2000,
        max_chars: int = 24000,
        args_trunc: int = 400,
    ) -> TrajectoryReport:
        """
        Reads captured trajectory from `stream_path` (either a `run_dir` or `trajectory.json` file).
        Returns a `TrajectoryReport` (subclass of `str` that also supports dict indexing).
        """
        target = Path(stream_path).resolve()
        traj_file = target if target.is_file() else (target / "trajectory.json")
        run_path = target.parent if target.is_file() else target

        if not traj_file.exists():
            meta = {
                "ok": False,
                "run_dir": str(run_path),
                "events": [],
                "actions": [],
                "observations": [],
                "errors": ["TRAJECTORY_NOT_FOUND"],
            }
            return TrajectoryReport("", meta)

        try:
            data = json.loads(traj_file.read_text(encoding="utf-8"))
            events = data.get("events", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            actions = [e for e in events if isinstance(e, dict) and e.get("type") == "action"]
            observations = [e for e in events if isinstance(e, dict) and e.get("type") == "observation"]
            errors = [
                e.get("error", str(e))
                for e in events
                if isinstance(e, dict) and e.get("type") == "error"
            ]
            if isinstance(data, dict) and isinstance(data.get("errors"), list):
                for err_str in data["errors"]:
                    if err_str not in errors:
                        errors.append(err_str)

            lines: List[str] = []
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                ev_type = ev.get("type", "event")
                step = ev.get("step", 0)
                if ev_type == "action":
                    cmd_str = str(ev.get("command") or ev.get("action") or "")[:args_trunc]
                    lines.append(f"[step {step} action] {cmd_str}")
                elif ev_type == "observation":
                    obs_str = str(ev.get("stdout") or ev.get("summary") or "")[:obs_trunc]
                    lines.append(f"[step {step} observation] {obs_str}")
                elif ev_type == "error":
                    err_s = str(ev.get("error") or "")[:obs_trunc]
                    lines.append(f"[step {step} error] {err_s}")

            formatted = "\n".join(lines)[:max_chars]
            meta = {
                "ok": True,
                "run_dir": str(run_path),
                "events": events,
                "actions": actions,
                "observations": observations,
                "errors": errors,
            }
            return TrajectoryReport(formatted, meta)
        except Exception as exc:
            meta = {
                "ok": False,
                "run_dir": str(run_path),
                "events": [],
                "actions": [],
                "observations": [],
                "errors": [f"TRAJECTORY_PARSE_ERROR:{exc}"],
            }
            return TrajectoryReport("", meta)


class AntigravityBenchmarkAdapter:
    """
    Concrete Antigravity implementation of the upstream `BenchmarkAdapter` protocol (`harness2/core/spec.py`).
    Strictly verifies agent-produced deliverables in `run_dir`, candidate tree invariants, and execution receipts.
    """

    PROTECTED_PATHS: Tuple[str, ...] = (
        ".git",
        ".harness/snapshots",
        ".harness/index",
        ".harness/receipts",
        "src/secret-vault.mjs",
    )

    METADATA_FILES: frozenset[str] = frozenset(
        {
            "receipt.json",
            "trajectory.json",
            "manifest.json",
            "candidate_spec.json",
            "assistant_response.md",
            ".harness-stage-context.json",
        }
    )

    def __init__(
        self,
        workspace_root: Optional[Union[str, Path]] = None,
        domain: str = "software-engineering",
        required_files: Optional[List[str]] = None,
        substrate: Optional[SubstrateLike] = None,
        spec: Optional[BenchSpec] = None,
    ) -> None:
        self.workspace_root = Path(workspace_root or Path.cwd()).resolve()
        self.domain = domain
        self.required_files: List[str] = list(required_files or [])
        self.substrate: SubstrateLike = substrate or AntigravitySubstrate(self.workspace_root)
        self.spec: BenchSpec = spec or BenchSpec(
            name=f"antigravity-{domain}",
            domains=(domain,),
            channels=(ChannelSpec(name="verification", description="Verified execution score", weight=1.0),),
        )

    def bench_spec(self, domain: Optional[str] = None) -> BenchSpec:
        dom = domain or self.domain
        return BenchSpec(
            name=f"antigravity-{dom}",
            domains=(dom,),
            channels=(ChannelSpec(name="verification", description="Verified execution score", weight=1.0),),
        )

    def tasks(self, split: str = "all") -> List[str]:
        lib = Harness2Library(self.workspace_root, self.domain)
        adopted = [str(item.get("task_id")) for item in lib.list_adopted_harnesses() if item.get("task_id")]
        return adopted or ["task-default-verification"]

    def domain_of(self, task_id: str) -> str:
        return self.domain

    def task_prompt(self, task_id: str) -> str:
        return f"Execute and verify task '{task_id}' in domain '{self.domain}'."

    def task_files(self, task_id: str) -> Optional[Path]:
        cand = self.workspace_root / ".harness" / "tasks" / task_id
        return cand if cand.exists() else None

    def base_harness(self) -> Path:
        plugin_dir = self.workspace_root / "plugin" / "harness-ide"
        return plugin_dir if plugin_dir.exists() else self.workspace_root

    def execute(
        self,
        task_id: str,
        harness_dir: Optional[Path],
        run_id: str,
        *,
        timeout: Optional[int] = None,
    ) -> Path:
        run_dir = (self.workspace_root / ".harness" / "runtime" / "runs" / run_id).resolve()
        if isinstance(self.substrate, AntigravitySubstrate):
            self.substrate._execute_single_run(
                {
                    "task_id": task_id,
                    "run_id": run_id,
                    "run_dir": str(run_dir),
                    "harness_dir": str(harness_dir) if harness_dir else None,
                    "required_files": self.required_files,
                    "timeout_s": timeout or self.spec.default_timeout,
                }
            )
        return run_dir

    def delivered(
        self,
        run_dir: Union[str, Path],
        required_files: Optional[List[str]] = None,
    ) -> bool:
        """
        Returns a strict `bool` (`True` or `False`).
        Checks ONLY agent-authored artifacts produced inside `run_dir / "deliverables"`
        or inside `run_dir` recorded in `receipt.json`. NEVER falls back to `self.workspace_root`!
        """
        run_path = Path(run_dir).resolve()
        if not run_path.exists() or not run_path.is_dir():
            return False

        # Never treat the repository workspace root itself as an executed run_dir unless it has a verified receipt/deliverables
        deliverables_dir = run_path / "deliverables"
        receipt_file = run_path / "receipt.json"
        receipt_data: Dict[str, Any] = {}
        if receipt_file.exists() and receipt_file.is_file():
            try:
                parsed = json.loads(receipt_file.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    receipt_data = parsed
            except Exception:
                return False

        req_list = list(required_files if required_files is not None else self.required_files)
        if req_list:
            for rel_file in req_list:
                rel_clean = str(rel_file).replace("\\", "/").lstrip("./")
                if ".." in Path(rel_clean).parts:
                    return False
                in_deliv = (deliverables_dir / rel_clean).resolve()
                if (
                    str(in_deliv).startswith(str(deliverables_dir.resolve()))
                    and in_deliv.exists()
                    and in_deliv.is_file()
                    and in_deliv.stat().st_size > 0
                ):
                    continue

                # Allow direct placement in an isolated run_dir (not workspace_root!) when recorded or inside run_path
                if run_path != self.workspace_root:
                    in_run = (run_path / rel_clean).resolve()
                    if (
                        str(in_run).startswith(str(run_path))
                        and in_run.exists()
                        and in_run.is_file()
                        and in_run.stat().st_size > 0
                        and in_run.name not in self.METADATA_FILES
                    ):
                        continue
                return False
            return True

        # When no explicit required_files list is configured, require non-empty deliverables in deliverables_dir
        # or verified executed receipt with produced files in an isolated run_dir
        if deliverables_dir.exists() and deliverables_dir.is_dir():
            for item in deliverables_dir.rglob("*"):
                if item.is_file() and item.stat().st_size > 0:
                    return True

        if (
            run_path != self.workspace_root
            and receipt_data.get("executed") is True
            and receipt_data.get("delivered") is True
        ):
            for item in run_path.rglob("*"):
                if item.is_file() and item.name not in self.METADATA_FILES and item.stat().st_size > 0:
                    return True

        return False

    def deliverable_files(self, run_dir: Union[str, Path]) -> Dict[str, str]:
        run_path = Path(run_dir).resolve()
        if not run_path.exists() or not run_path.is_dir():
            return {}
        out: Dict[str, str] = {}
        deliverables_dir = run_path / "deliverables"
        search_root = deliverables_dir if deliverables_dir.exists() else (run_path if run_path != self.workspace_root else None)
        if search_root is None:
            return {}
        for item in sorted(search_root.rglob("*")):
            if not item.is_file() or item.name in self.METADATA_FILES:
                continue
            rel = str(item.relative_to(search_root)).replace("\\", "/")
            try:
                out[rel] = item.read_text(encoding="utf-8")
            except Exception:
                out[rel] = f"<binary:{item.stat().st_size} bytes>"
        return out

    def deliverable_text(self, run_dir: Union[str, Path]) -> str:
        files = self.deliverable_files(run_dir)
        return "\n\n".join(f"### {rel}\n{body}" for rel, body in files.items())

    def trajectory(self, run_dir: Union[str, Path], *, obs_trunc: int = 2000) -> str:
        if isinstance(self.substrate, AntigravitySubstrate):
            return str(self.substrate.read_trajectory(Path(run_dir), obs_trunc=obs_trunc))
        return ""

    def validate_tree(self, tree: Union[Dict[str, str], str, Path]) -> Optional[Dict[str, Any]]:
        """
        Validates a candidate harness tree against `SurfaceSpec` invariants.
        - Upstream contract: accepts `tree: dict[str, str]` (path -> content) and raises `ValueError` on violation.
        - Directory path support: also accepts a `Path | str` directory on disk and raises `ValueError` on violation.
        """
        surf = self.substrate.surface()
        protected_set = set(surf.protected_paths) | set(self.PROTECTED_PATHS)

        if isinstance(tree, Mapping):
            if len(tree) == 0:
                raise ValueError("Candidate harness tree must not be empty.")

            always_on_total_chars = 0
            for raw_rel, content in tree.items():
                if not isinstance(raw_rel, str) or not raw_rel.strip():
                    raise ValueError("Candidate tree contains an empty path key.")
                if not isinstance(content, str):
                    raise ValueError(f"Candidate tree content for '{raw_rel}' must be a string.")

                norm_rel = raw_rel.replace("\\", "/").strip()
                if norm_rel.startswith("/") or norm_rel.startswith("\\") or ":" in norm_rel:
                    raise ValueError(f"Absolute path rejected in candidate tree: {raw_rel}")
                parts = Path(norm_rel).parts
                if ".." in parts:
                    raise ValueError(f"Path traversal ('..') rejected in candidate tree: {raw_rel}")

                clean_rel = norm_rel
                while clean_rel.startswith("./"):
                    clean_rel = clean_rel[2:]
                if (
                    clean_rel == ".git"
                    or clean_rel.startswith(".git/")
                    or clean_rel in (".harness/snapshots/active.lock.json",)
                    or any(clean_rel == p or clean_rel.startswith(p + "/") for p in protected_set)
                ):
                    raise ValueError(f"Protected path cannot be modified by candidate tree: {clean_rel}")

                if clean_rel in surf.always_on:
                    if surf.reject_empty_always_on and not content.strip():
                        raise ValueError(f"Always-on file '{clean_rel}' cannot be empty.")
                    always_on_total_chars += len(content)

                if clean_rel.endswith(".json"):
                    try:
                        parsed = json.loads(content)
                        if not isinstance(parsed, dict):
                            raise ValueError(f"JSON file '{clean_rel}' must contain a JSON object.")
                    except json.JSONDecodeError as exc:
                        raise ValueError(f"Malformed JSON in '{clean_rel}': {exc}") from exc

            if always_on_total_chars > surf.always_on_max:
                raise ValueError(
                    f"Always-on content length ({always_on_total_chars}) exceeds always_on_max ({surf.always_on_max})."
                )
            return None

        tree_path = Path(tree).resolve()
        if not tree_path.exists() or not tree_path.is_dir():
            raise ValueError(f"Candidate tree directory does not exist: {tree_path}")

        collected: Dict[str, str] = {}
        for item in tree_path.rglob("*"):
            resolved = item.resolve()
            if not str(resolved).startswith(str(tree_path)):
                raise ValueError(f"Symlink or path escape detected in candidate tree: {item}")
            if item.is_file():
                rel = str(item.relative_to(tree_path)).replace("\\", "/")
                try:
                    collected[rel] = item.read_text(encoding="utf-8")
                except Exception:
                    collected[rel] = ""

        self.validate_tree(collected)
        return {
            "ok": True,
            "valid": True,
            "tree_dir": str(tree_path),
            "errors": [],
        }

    def score(
        self,
        run_dir: Union[str, Path],
        task_id: str = "",
        required_files: Optional[List[str]] = None,
        validator_cmd: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Upstream `BenchmarkAdapter.score(run_dir: Path, task_id: str) -> dict | None`.
        Returns `None` when `delivered(run_dir)` is `False` or when no real execution receipt
        and non-empty trajectory exist in `run_dir` — never fabricates `1.0` on an empty run!
        """
        run_path = Path(run_dir).resolve()
        if not self.delivered(run_path, required_files):
            return None

        receipt_file = run_path / "receipt.json"
        traj_file = run_path / "trajectory.json"
        if not receipt_file.exists() or not traj_file.exists():
            return None

        try:
            receipt_data = json.loads(receipt_file.read_text(encoding="utf-8"))
            traj_data = json.loads(traj_file.read_text(encoding="utf-8"))
        except Exception:
            return None

        if not isinstance(receipt_data, dict) or not isinstance(traj_data, dict):
            return None

        if receipt_data.get("executed") is not True or receipt_data.get("synthetic") is True:
            return None

        events = traj_data.get("events", [])
        if not isinstance(events, list) or len(events) == 0:
            return None

        if validator_cmd:
            proc = subprocess.run(
                validator_cmd if isinstance(validator_cmd, list) else str(validator_cmd),
                shell=isinstance(validator_cmd, str),
                cwd=str(run_path),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
                check=False,
            )
            passed = proc.returncode == 0
            return {
                "ok": passed,
                "passed": passed,
                "score": 1.0 if passed else 0.0,
                "status": "passed" if passed else "failed",
                "task_id": task_id or str(receipt_data.get("task_id", "")),
                "run_dir": str(run_path),
                "delivered": True,
                "verifier_executed": True,
                "validator_exit_code": proc.returncode,
            }

        if receipt_data.get("verifier_executed") is False:
            return {
                "ok": False,
                "passed": False,
                "passed_verification": False,
                "score": 0.0,
                "status": "delivered_unverified",
                "task_id": task_id or str(receipt_data.get("task_id", "")),
                "run_dir": str(run_path),
                "delivered": True,
                "verifier_executed": False,
                "reason": "NO_INDEPENDENT_VERIFIER_CONFIGURED",
            }

        if "passed_verification" not in receipt_data and "verification_score" not in receipt_data:
            return None

        passed = bool(receipt_data.get("passed_verification", False))
        raw_score = float(receipt_data.get("verification_score", 1.0 if passed else 0.0))
        return {
            "ok": passed,
            "passed": passed,
            "score": raw_score,
            "status": "passed" if passed else "failed",
            "task_id": task_id or str(receipt_data.get("task_id", "")),
            "run_dir": str(run_path),
            "delivered": True,
            "verifier_executed": True,
        }

    def judge(
        self,
        run_dir: Union[str, Path],
        required_files: Optional[List[str]] = None,
        validator_cmd: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        return self.score(run_dir, required_files=required_files, validator_cmd=validator_cmd)


Substrate._concrete_cls = AntigravitySubstrate
BenchmarkAdapter._concrete_cls = AntigravityBenchmarkAdapter


class AntigravityExecutor(AntigravitySubstrate):
    """
    Execution substrate adapter for Harness² Propose -> Probe -> Compose loops.

    Binds `.agents/rules/gravity-well-default.md` into worker system instructions and enforces
    strict separation between real verified rollouts (`allow_simulation=False`, default)
    and explicit self-test/demo simulations (`allow_simulation=True`).
    """

    name: str = "antigravity"

    def __init__(
        self,
        workspace_root: Optional[Union[str, Path]] = None,
        substrate: str = "auto",
        reasoning_depth: str = "balanced",
        thinking_budget_tokens: Optional[int] = None,
        max_probe_steps: Optional[int] = None,
        prober_model_tier: Optional[str] = None,
        early_stop: Optional[bool] = None,
        allow_simulation: bool = False,
        strict_execution: bool = True,
    ) -> None:
        super().__init__(workspace_root=workspace_root)
        self.substrate = substrate
        self.allow_simulation = bool(allow_simulation)
        self.strict_execution = bool(strict_execution)
        preset = dict(
            REASONING_DEPTH_PROFILES.get(
                reasoning_depth.lower(), REASONING_DEPTH_PROFILES["balanced"]
            )
        )
        if thinking_budget_tokens is not None:
            preset["thinking_budget_tokens"] = int(thinking_budget_tokens)
        if max_probe_steps is not None:
            preset["max_probe_steps"] = int(max_probe_steps)
        if prober_model_tier is not None:
            preset["prober_model_tier"] = str(prober_model_tier)
        if early_stop is not None:
            preset["early_stop_on_first_pass"] = bool(early_stop)
        self.reasoning_profile = preset
        self.default_operating_contract = self.load_default_operating_contract()
        self.system_instructions = self.default_operating_contract
        self._rag_engine_uri = (Path(__file__).resolve().parent.parent / "src" / "rag-engine.mjs").as_uri()

    def load_default_operating_contract(self) -> str:
        """Loads `.agents/rules/gravity-well-default.md` so Python workers bind the default engineering contract."""
        candidates = [
            self.workspace_root / ".agents" / "rules" / "gravity-well-default.md",
            Path(__file__).resolve().parent.parent / ".agents" / "rules" / "gravity-well-default.md",
        ]
        for contract_path in candidates:
            if contract_path.exists() and contract_path.is_file():
                try:
                    return contract_path.read_text(encoding="utf-8").strip()
                except Exception:
                    continue
        return ""

    def build_system_instructions(self, candidate: Optional[HarnessCandidateSpec] = None, snapshot_id: str = "") -> str:
        thinking_cap = (
            candidate.thinking_budget_tokens
            if candidate and candidate.thinking_budget_tokens
            else self.reasoning_profile["thinking_budget_tokens"]
        )
        max_steps = candidate.max_steps if candidate else self.reasoning_profile["max_probe_steps"]
        parts = []
        if self.default_operating_contract:
            parts.append(self.default_operating_contract)
        if candidate and candidate.system_prompts:
            parts.append(candidate.system_prompts)
        if snapshot_id:
            parts.append(
                f"Active Harness2 Snapshot Lock: {snapshot_id}. "
                f"Token-Efficiency Guardrail: Keep reasoning concise (<= {thinking_cap} thinking tokens, "
                f"<= {max_steps} steps). Query local RAG with snapshot_id={snapshot_id} before planning."
            )
        return "\n\n".join(parts)

    def _call_rag_node(self, js_expr: str) -> Dict[str, Any]:
        """Invokes the local Node.js HarnessKnowledgeEngine for snapshot & library ops."""
        cmd = ["node", "-e", js_expr]
        res = subprocess.run(
            cmd,
            cwd=str(self.workspace_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
            check=False,
        )
        if res.returncode != 0:
            raise RuntimeError(f"RAG engine call failed: {res.stderr.strip()}")
        out = res.stdout.strip().splitlines()[-1] if res.stdout.strip() else "{}"
        return json.loads(out)

    def create_snapshot_lock(
        self,
        domain: str,
        k: int,
        mode: str,
        description: str,
        owner_run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        ws_json = json.dumps(str(self.workspace_root))
        uri_json = json.dumps(self._rag_engine_uri)
        payload = json.dumps(
            {
                "domain": domain,
                "k": k,
                "mode": mode,
                "description": description,
                "ownerRunId": owner_run_id,
            }
        )
        js = (
            f"import({uri_json}).then(({{HarnessKnowledgeEngine}}) => {{"
            f"const eng = new HarnessKnowledgeEngine({ws_json});"
            f"console.log(JSON.stringify(eng.createSnapshotLock({payload})));"
            "});"
        )
        return self._call_rag_node(js)

    def release_snapshot_lock(
        self,
        owner_run_id: Optional[str] = None,
        snapshot_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        ws_json = json.dumps(str(self.workspace_root))
        uri_json = json.dumps(self._rag_engine_uri)
        payload = json.dumps({"ownerRunId": owner_run_id, "snapshotId": snapshot_id})
        js = (
            f"import({uri_json}).then(({{HarnessKnowledgeEngine}}) => {{"
            f"const eng = new HarnessKnowledgeEngine({ws_json});"
            f"console.log(JSON.stringify(eng.releaseSnapshotLock({payload})));"
            "});"
        )
        return self._call_rag_node(js)

    def query_knowledge(
        self, query: str, collection: str = "all", snapshot_id: Optional[str] = None
    ) -> Dict[str, Any]:
        ws_json = json.dumps(str(self.workspace_root))
        uri_json = json.dumps(self._rag_engine_uri)
        payload = json.dumps({"query": query, "collection": collection, "snapshot_id": snapshot_id})
        js = (
            f"import({uri_json}).then(({{HarnessKnowledgeEngine}}) => {{"
            f"const eng = new HarnessKnowledgeEngine({ws_json});"
            f"console.log(JSON.stringify(eng.query({payload})));"
            "});"
        )
        return self._call_rag_node(js)

    def record_experience(self, record_payload: Dict[str, Any]) -> Dict[str, Any]:
        ws_json = json.dumps(str(self.workspace_root))
        uri_json = json.dumps(self._rag_engine_uri)
        payload = json.dumps(record_payload)
        js = (
            f"import({uri_json}).then(({{HarnessKnowledgeEngine}}) => {{"
            f"const eng = new HarnessKnowledgeEngine({ws_json});"
            f"console.log(JSON.stringify(eng.recordExperience({payload})));"
            "});"
        )
        return self._call_rag_node(js)

    def create_evaluation_receipt(self, receipt_payload: Dict[str, Any]) -> Dict[str, Any]:
        ws_json = json.dumps(str(self.workspace_root))
        uri_json = json.dumps(self._rag_engine_uri)
        payload = json.dumps(receipt_payload)
        js = (
            f"import({uri_json}).then(({{HarnessKnowledgeEngine}}) => {{"
            f"const eng = new HarnessKnowledgeEngine({ws_json});"
            f"console.log(JSON.stringify(eng.createEvaluationReceipt({payload})));"
            "});"
        )
        return self._call_rag_node(js)

    PUBLIC_SDK_LOCAL_AGENT_CONFIG_FIELDS: Tuple[str, ...] = (
        "workspaces",
        "model",
        "api_key",
        "system_instructions",
        "policies",
        "hooks",
        "mcp_servers",
        "budget_config",
        "compaction_config",
        "conversation_id",
        "session_continuation_mode",
        "save_dir",
    )

    def build_sdk_agent_config(
        self,
        candidate: HarnessCandidateSpec,
        snapshot_id: str,
        *,
        task_id: str = "task-probe",
    ) -> Dict[str, Any]:
        """
        Builds a documented public `google.antigravity` `LocalAgentConfig` dictionary
        without undocumented kwargs (`workspace_root`, `max_steps`, `thinking_budget_tokens`).
        """
        thinking_cap = candidate.thinking_budget_tokens or self.reasoning_profile["thinking_budget_tokens"]
        sys_instructions = self.build_system_instructions(candidate, snapshot_id)
        save_dir_path = (
            self.workspace_root / ".harness" / "runtime" / "sdk-sessions" / f"{task_id}-{candidate.candidate_id}"
        ).resolve()
        return {
            "workspaces": [str(self.workspace_root)],
            "model": str(candidate.model_tier or self.reasoning_profile["prober_model_tier"] or "auto"),
            "api_key": os.environ.get("GEMINI_API_KEY", ""),
            "system_instructions": sys_instructions,
            "policies": {"terminal_execution": "auto"},
            "budget_config": {
                "max_iterations": int(candidate.max_steps),
                "max_tokens": int(max(4096, thinking_cap * 4)),
            },
            "compaction_config": {"enabled": True},
            "save_dir": str(save_dir_path),
        }

    def validate_sdk_agent_config(self, config_dict: Mapping[str, Any]) -> Dict[str, Any]:
        unknown = [k for k in config_dict.keys() if k not in self.PUBLIC_SDK_LOCAL_AGENT_CONFIG_FIELDS]
        return {
            "ok": len(unknown) == 0,
            "unknown_fields": unknown,
            "unsupported_keys": unknown,
            "allowed_fields": list(self.PUBLIC_SDK_LOCAL_AGENT_CONFIG_FIELDS),
        }

    async def probe_candidate_async(
        self,
        task_prompt: str,
        candidate: HarnessCandidateSpec,
        snapshot_id: str,
        *,
        task_id: str = "task-probe",
        allow_simulation: bool = False,
        command: Optional[Union[str, List[str]]] = None,
        required_files: Optional[List[str]] = None,
        validator_cmd: Optional[Union[str, List[str]]] = None,
    ) -> ProbeTrajectoryResult:
        """Executes a single candidate harness probe under the locked `snapshot_id`."""
        stop_check = self._check_task_stop_state(task_id)
        if stop_check is not None:
            return ProbeTrajectoryResult(
                candidate_id=candidate.candidate_id,
                snapshot_id=snapshot_id,
                workspace_mode="branch",
                passed_verification=False,
                verification_score=0.0,
                steps_executed=0,
                tool_errors=1,
                prompt_tokens=0,
                candidates_tokens=0,
                thoughts_tokens=0,
                observed_summary="Execution blocked by ESCALATED_NO_PROGRESS_STOP.",
                evidence_paths=[],
                front=candidate.front,
                model_tier=candidate.model_tier,
                thinking_budget_tokens=candidate.thinking_budget_tokens or 2048,
                total_tokens=0,
                unoptimized_tokens=0,
                tokens_saved=0,
                tokens_saved_pct=0.0,
                synthetic=False,
                execution_mode="escalated_stop",
                verifier_executed=False,
                usage_complete=False,
                observed_tokens=None,
            )

        unoptimized_baseline_tokens = 16700
        thinking_cap = candidate.thinking_budget_tokens or self.reasoning_profile["thinking_budget_tokens"]
        snippet_cap = self.reasoning_profile["rag_snippet_max_chars"]
        sys_instructions = self.build_system_instructions(candidate, snapshot_id)

        # 1. Check if google.antigravity SDK is requested and available with credentials
        if self.substrate in ("antigravity-sdk", "auto") and os.environ.get("GEMINI_API_KEY"):
            try:
                from google.antigravity import Agent, LocalAgentConfig, types  # type: ignore

                public_cfg_dict = self.build_sdk_agent_config(
                    candidate, snapshot_id, task_id=task_id
                )
                try:
                    budget_obj = (
                        types.BudgetConfig(**public_cfg_dict["budget_config"])
                        if hasattr(types, "BudgetConfig")
                        else public_cfg_dict["budget_config"]
                    )
                    compaction_obj = (
                        types.CompactionConfig(**public_cfg_dict["compaction_config"])
                        if hasattr(types, "CompactionConfig")
                        else public_cfg_dict["compaction_config"]
                    )
                    config = LocalAgentConfig(
                        workspaces=public_cfg_dict["workspaces"],
                        model=public_cfg_dict["model"],
                        api_key=public_cfg_dict["api_key"],
                        system_instructions=sys_instructions,
                        budget_config=budget_obj,
                        compaction_config=compaction_obj,
                        save_dir=public_cfg_dict["save_dir"],
                    )
                except TypeError:
                    config = LocalAgentConfig(
                        system_instructions=sys_instructions,
                    )

                async with Agent(config) as agent:
                    response = await agent.chat(task_prompt)
                    text_out = await response.text()
                    usage = getattr(agent.conversation, "total_usage", None)
                    raw_p = getattr(usage, "prompt_token_count", None) if usage is not None else None
                    raw_c = getattr(usage, "candidates_token_count", None) if usage is not None else None
                    raw_t = getattr(usage, "thoughts_token_count", None) if usage is not None else None
                    has_observed_usage = any(v is not None for v in (raw_p, raw_c, raw_t))
                    p_tok = int(raw_p or 0)
                    c_tok = int(raw_c or 0)
                    t_tok = int(raw_t or 0)
                    tot_tok = p_tok + c_tok + t_tok

                    run_dir = (
                        self.workspace_root
                        / ".harness"
                        / "runtime"
                        / "runs"
                        / f"{task_id}-{candidate.candidate_id}"
                    ).resolve()
                    deliv_dir = run_dir / "deliverables"
                    deliv_dir.mkdir(parents=True, exist_ok=True)
                    # Store model prose output as metadata (assistant_response.md), NEVER as a deliverable artifact!
                    if text_out.strip():
                        (run_dir / "assistant_response.md").write_text(text_out, encoding="utf-8")

                    bench = AntigravityBenchmarkAdapter(
                        self.workspace_root, required_files=required_files
                    )
                    deliv_ok = bench.delivered(run_dir, required_files)
                    verifier_ran = bool(validator_cmd)
                    traj_payload = {
                        "run_id": f"{task_id}-{candidate.candidate_id}",
                        "run_dir": str(run_dir),
                        "executed": True,
                        "events": [
                            {"type": "action", "step": 1, "action": "agent.chat", "candidate_id": candidate.candidate_id},
                            {"type": "observation", "step": 1, "summary": text_out[:2000]},
                        ],
                        "errors": [] if deliv_ok else ["MISSING_DELIVERABLES"],
                    }
                    receipt_payload = {
                        "run_id": f"{task_id}-{candidate.candidate_id}",
                        "task_id": task_id,
                        "run_dir": str(run_dir),
                        "executed": True,
                        "verifier_executed": verifier_ran,
                        "synthetic": False,
                        "status": "delivered_unverified" if (deliv_ok and not verifier_ran) else ("succeeded" if deliv_ok else "failed"),
                        "passed_verification": False,
                        "verification_score": 0.0,
                        "delivered": deliv_ok,
                        "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    }
                    (run_dir / "trajectory.json").write_text(json.dumps(traj_payload, indent=2), encoding="utf-8")
                    (run_dir / "receipt.json").write_text(json.dumps(receipt_payload, indent=2), encoding="utf-8")

                    scored = bench.score(
                        run_dir,
                        task_id=task_id,
                        required_files=required_files,
                        validator_cmd=validator_cmd if isinstance(validator_cmd, list) else ([validator_cmd] if isinstance(validator_cmd, str) else None),
                    )
                    passed_ver = bool(scored and scored.get("passed"))
                    ver_score = float(scored.get("score", 0.0)) if scored else 0.0
                    saved_tok = max(0, unoptimized_baseline_tokens - tot_tok) if (has_observed_usage and tot_tok > 0) else 0
                    saved_pct = (
                        round((saved_tok / unoptimized_baseline_tokens) * 100.0, 1)
                        if (has_observed_usage and tot_tok > 0)
                        else 0.0
                    )
                    return ProbeTrajectoryResult(
                        candidate_id=candidate.candidate_id,
                        snapshot_id=snapshot_id,
                        workspace_mode="branch",
                        passed_verification=passed_ver,
                        verification_score=ver_score,
                        steps_executed=1,
                        tool_errors=0 if passed_ver else 1,
                        prompt_tokens=p_tok,
                        candidates_tokens=c_tok,
                        thoughts_tokens=t_tok,
                        observed_summary=text_out[:300],
                        evidence_paths=[str(run_dir.relative_to(self.workspace_root)).replace("\\", "/")],
                        front=candidate.front,
                        model_tier=candidate.model_tier,
                        thinking_budget_tokens=thinking_cap,
                        total_tokens=tot_tok,
                        unoptimized_tokens=unoptimized_baseline_tokens if has_observed_usage else 0,
                        tokens_saved=saved_tok,
                        tokens_saved_pct=saved_pct,
                        synthetic=False,
                        execution_mode="verified" if passed_ver else ("delivered_unverified" if deliv_ok else "failed"),
                        verifier_executed=verifier_ran,
                        usage_complete=has_observed_usage,
                        observed_tokens=tot_tok if has_observed_usage else None,
                    )
            except Exception:
                if self.substrate == "antigravity-sdk":
                    raise

        # 2. If a real execution command is supplied, execute and score via BenchmarkAdapter
        if command:
            run_dir = (
                self.workspace_root
                / ".harness"
                / "runtime"
                / "runs"
                / f"{task_id}-{candidate.candidate_id}"
            ).resolve()
            exec_res = self._execute_single_run(
                {
                    "task_id": task_id,
                    "run_id": f"{task_id}-{candidate.candidate_id}",
                    "run_dir": str(run_dir),
                    "command": command,
                    "validator_cmd": validator_cmd,
                    "required_files": required_files or [],
                }
            )
            bench = AntigravityBenchmarkAdapter(self.workspace_root, required_files=required_files)
            scored = bench.score(
                run_dir,
                task_id=task_id,
                required_files=required_files,
                validator_cmd=validator_cmd if isinstance(validator_cmd, list) else None,
            )
            passed = bool(scored and scored.get("passed"))
            ver_score = float(scored.get("score", 0.0)) if scored else 0.0
            exec_status = str(scored.get("status") if scored else exec_res.get("status", "failed"))
            return ProbeTrajectoryResult(
                candidate_id=candidate.candidate_id,
                snapshot_id=snapshot_id,
                workspace_mode="branch",
                passed_verification=passed,
                verification_score=ver_score,
                steps_executed=int(exec_res.get("steps_executed", 1)),
                tool_errors=len(exec_res.get("errors", [])),
                prompt_tokens=0,
                candidates_tokens=0,
                thoughts_tokens=0,
                observed_summary=f"Executed rollout in {run_dir.name}: status={exec_status}, passed={passed}, score={ver_score}",
                evidence_paths=exec_res.get("delivered_files", []),
                front=candidate.front,
                model_tier=candidate.model_tier,
                thinking_budget_tokens=thinking_cap,
                total_tokens=0,
                unoptimized_tokens=0,
                tokens_saved=0,
                tokens_saved_pct=0.0,
                synthetic=False,
                execution_mode="verified" if passed else ("delivered_unverified" if exec_status == "delivered_unverified" else "failed"),
                verifier_executed=bool(exec_res.get("verifier_executed", False)),
                usage_complete=False,
                observed_tokens=None,
                artifact_hashes=dict(exec_res.get("artifact_hashes") or {}),
            )

        # 3. When allow_simulation is False (default), refuse to fabricate verification scores or token counts
        if not allow_simulation:
            return ProbeTrajectoryResult(
                candidate_id=candidate.candidate_id,
                snapshot_id=snapshot_id,
                workspace_mode="branch",
                passed_verification=False,
                verification_score=0.0,
                steps_executed=0,
                tool_errors=1,
                prompt_tokens=0,
                candidates_tokens=0,
                thoughts_tokens=0,
                observed_summary=(
                    f"Candidate '{candidate.candidate_id}' failed: no verified execution provider, "
                    f"credentials, or rollout command available (allow_simulation=False)."
                ),
                evidence_paths=[],
                front=candidate.front,
                model_tier=candidate.model_tier,
                thinking_budget_tokens=thinking_cap,
                total_tokens=0,
                unoptimized_tokens=0,
                tokens_saved=0,
                tokens_saved_pct=0.0,
                synthetic=False,
                execution_mode="failed",
                verifier_executed=False,
                usage_complete=False,
                observed_tokens=None,
            )

        # 4. Explicit simulation / self-test probe (ONLY when allow_simulation=True)
        rag_res = self.query_knowledge(task_prompt, collection="all", snapshot_id=snapshot_id)
        top_hits = rag_res.get("results", [])
        has_snapshot_guard = "snapshot" in candidate.hypothesis.lower() or len(candidate.rules) > 0
        has_subagent_isolation = (
            any("branch" in s.lower() for s in candidate.subagents) or len(candidate.skills) > 0
        )

        score = 0.62
        if top_hits:
            score += 0.14
        if has_snapshot_guard:
            score += 0.12
        if has_subagent_isolation:
            score += 0.10

        depth = self.reasoning_profile["reasoning_depth"]
        prompt_tok = 1950 if depth == "eco" else (3100 if depth == "balanced" else 5400)
        thoughts_tok = min(
            thinking_cap, 780 if depth == "eco" else (1480 if depth == "balanced" else 4200)
        )
        cand_tok = 520 if depth == "eco" else (740 if depth == "balanced" else 1180)
        total_tok = prompt_tok + thoughts_tok + cand_tok
        saved_tok = max(0, unoptimized_baseline_tokens - total_tok)
        saved_pct = round((saved_tok / unoptimized_baseline_tokens) * 100.0, 1)

        return ProbeTrajectoryResult(
            candidate_id=candidate.candidate_id,
            snapshot_id=snapshot_id,
            workspace_mode="branch" if has_subagent_isolation else "inherit",
            passed_verification=score >= 0.80,
            verification_score=round(score, 3),
            steps_executed=min(candidate.max_steps, 3 if has_subagent_isolation else 5),
            tool_errors=0 if has_snapshot_guard else 1,
            prompt_tokens=prompt_tok,
            candidates_tokens=cand_tok,
            thoughts_tokens=thoughts_tok,
            observed_summary=(
                f"[SIMULATED:{candidate.front}] Candidate '{candidate.candidate_id}' retrieved {len(top_hits)} snapshot-isolated docs "
                f"(lock={snapshot_id}, snippetCap={snippet_cap}), model={candidate.model_tier}, thinkingCap={thinking_cap}, "
                f"verification_score={score:.2f}, total_tokens={total_tok} ({saved_pct}% saved)."
            ),
            evidence_paths=[h.get("path", "") for h in top_hits[:2] if h.get("path")],
            front=candidate.front,
            model_tier=candidate.model_tier,
            thinking_budget_tokens=thinking_cap,
            total_tokens=total_tok,
            unoptimized_tokens=unoptimized_baseline_tokens,
            tokens_saved=saved_tok,
            tokens_saved_pct=saved_pct,
            synthetic=True,
            execution_mode="simulation",
            verifier_executed=False,
            usage_complete=True,
            observed_tokens=total_tok,
        )

    def run_propose_probe_compose(
        self,
        task_id: str,
        domain: str = "software-engineering",
        problem: str = "",
        k: int = 2,
        mode: str = "parallel",
        record_to_library: bool = True,
        allow_simulation: Optional[bool] = None,
        command: Optional[Union[str, List[str]]] = None,
        required_files: Optional[List[str]] = None,
        validator_cmd: Optional[Union[str, List[str]]] = None,
    ) -> Dict[str, Any]:
        """Runs a full Propose -> Probe -> Compose cycle with Snapshot Isolation and Reasoning Depth Guardrails."""
        stop_check = self._check_task_stop_state(task_id)
        if stop_check is not None:
            return stop_check
        allow_simulation = bool(self.allow_simulation if allow_simulation is None else allow_simulation)

        profile = self.reasoning_profile
        model_tier = profile["prober_model_tier"]
        thinking_cap = profile["thinking_budget_tokens"]
        max_steps = profile["max_probe_steps"]
        early_stop = profile["early_stop_on_first_pass"]
        owner_run_id = f"py-loop-{task_id}-{os.getpid()}-{int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)}"

        # 1. Create Snapshot Lock with ownerRunId
        lock = self.create_snapshot_lock(
            domain=domain,
            k=k,
            mode=mode,
            description=f"Propose-Probe-Compose ({profile['reasoning_depth']}) for {task_id}",
            owner_run_id=owner_run_id,
        )
        if not lock or lock.get("ok") is False or not lock.get("snapshotId"):
            return {
                "ok": False,
                "status": "failed",
                "error": (lock or {}).get("error", "SNAPSHOT_LOCK_ACTIVE_BY_ANOTHER_RUN"),
                "task_id": task_id,
                "domain": domain,
                "snapshotLock": lock,
                "winner": {
                    "candidate_id": None,
                    "passed_verification": False,
                    "verification_score": 0.0,
                    "score": 0.0,
                },
                "allProbeResults": [],
                "recordedExperience": None,
            }

        snapshot_id = lock["snapshotId"]
        compact_lock = {
            k_name: v_val
            for k_name, v_val in lock.items()
            if k_name not in ("frozenDocuments", "dfMap")
        }

        try:
            # 2. Propose K contrastive candidate harnesses (Invariant Front + Domain-Specific Front)
            candidates: List[HarnessCandidateSpec] = [
                HarnessCandidateSpec(
                    candidate_id="candidate-1-invariant-guardrail",
                    front="invariant",
                    model_tier=model_tier,
                    thinking_budget_tokens=thinking_cap,
                    max_steps=max_steps,
                    hypothesis="Invariant front: bound thinking budget and enforce pre-completion verification.",
                    system_prompts=f"Solve the task concisely within {thinking_cap} thinking tokens and {max_steps} steps.",
                    rules=[".agents/rules/gravity-well-default.md", "plugin/harness-ide/rules/AGENTS.md"],
                ),
                HarnessCandidateSpec(
                    candidate_id="candidate-2-harness2-rag-branched",
                    front="domain-specific",
                    model_tier=model_tier,
                    thinking_budget_tokens=thinking_cap,
                    max_steps=max(3, max_steps - 1),
                    hypothesis=(
                        "Domain-specific front: enforce Cue-First RAG retrieval over frozen snapshot_id and run probers "
                        "in isolated Workspace: branch."
                    ),
                    system_prompts="Query project-knowledge and experiment-knowledge cues before planning.",
                    rules=[".agents/rules/gravity-well-default.md", "plugin/harness-ide/rules/AGENTS.md"],
                    skills=["plugin/harness-ide/skills/harness2-loop/SKILL.md"],
                    subagents=[f"harness-prober (Workspace: branch, model: {model_tier})"],
                ),
            ]
            while len(candidates) < k:
                idx = len(candidates) + 1
                candidates.append(
                    HarnessCandidateSpec(
                        candidate_id=f"candidate-{idx}-hybrid-early-stop",
                        front="hybrid",
                        model_tier=model_tier,
                        thinking_budget_tokens=int(thinking_cap * 0.85),
                        max_steps=max(3, max_steps - 1),
                        hypothesis="Hybrid front: combine snapshot lock with post-tool test verification and early-stop.",
                        rules=[".agents/rules/gravity-well-default.md", "plugin/harness-ide/rules/AGENTS.md"],
                        skills=["plugin/harness-ide/skills/harness2-loop/SKILL.md"],
                        scripts=["test/harness-ide.test.mjs"],
                        subagents=[f"harness-prober (Workspace: branch, model: {model_tier})"],
                    )
                )

            # 3. Probe candidates (parallel or sequential with early-stop token guardrail)
            async def _run_all() -> List[ProbeTrajectoryResult]:
                if mode == "parallel":
                    return list(
                        await asyncio.gather(
                            *(
                                self.probe_candidate_async(
                                    problem,
                                    c,
                                    snapshot_id,
                                    task_id=task_id,
                                    allow_simulation=allow_simulation,
                                    command=command,
                                    required_files=required_files,
                                    validator_cmd=validator_cmd,
                                )
                                for c in candidates[:k]
                            )
                        )
                    )
                results: List[ProbeTrajectoryResult] = []
                passed_cleanly = False
                for c in candidates[:k]:
                    if early_stop and passed_cleanly:
                        results.append(
                            ProbeTrajectoryResult(
                                candidate_id=c.candidate_id,
                                snapshot_id=snapshot_id,
                                workspace_mode="branch",
                                passed_verification=True,
                                verification_score=0.0,
                                steps_executed=0,
                                tool_errors=0,
                                prompt_tokens=0,
                                candidates_tokens=0,
                                thoughts_tokens=0,
                                observed_summary="Skipped via Early-Stop Token Guardrail after prior candidate verified cleanly.",
                                evidence_paths=[],
                                front=c.front,
                                model_tier=c.model_tier,
                                thinking_budget_tokens=c.thinking_budget_tokens,
                                total_tokens=0,
                                unoptimized_tokens=16700 if allow_simulation else 0,
                                tokens_saved=16700 if allow_simulation else 0,
                                tokens_saved_pct=100.0 if allow_simulation else 0.0,
                                early_stopped=True,
                                synthetic=bool(allow_simulation),
                                execution_mode="early_stopped",
                            )
                        )
                        continue
                    res = await self.probe_candidate_async(
                        problem,
                        c,
                        snapshot_id,
                        task_id=task_id,
                        allow_simulation=allow_simulation,
                        command=command,
                        required_files=required_files,
                        validator_cmd=validator_cmd,
                    )
                    if res.passed_verification and res.verification_score >= 0.90 and res.tool_errors == 0:
                        passed_cleanly = True
                    results.append(res)
                return results

            probe_results = asyncio.run(_run_all())

            # 4. Compose winning candidate by behavioral contrast
            active_results = [r for r in probe_results if not r.early_stopped]
            ranked = sorted(
                active_results or probe_results,
                key=lambda r: (
                    r.passed_verification,
                    r.verification_score,
                    -r.tool_errors,
                    -r.total_tokens,
                ),
                reverse=True,
            )
            winner = ranked[0]
            winning_spec = next(c for c in candidates if c.candidate_id == winner.candidate_id)

            is_simulated_run = bool(
                any(
                    getattr(r, "synthetic", False)
                    or getattr(r, "execution_mode", "") == "simulation"
                    or "[SIMULATED" in (r.observed_summary or "")
                    for r in probe_results
                )
            )

            if not winner.passed_verification:
                fail_status = (
                    "delivered_unverified"
                    if getattr(winner, "execution_mode", "") == "delivered_unverified"
                    else "failed"
                )
                return {
                    "ok": False,
                    "status": fail_status,
                    "error": "NO_CANDIDATE_PASSED_VERIFICATION",
                    "synthetic": is_simulated_run,
                    "task_id": task_id,
                    "domain": domain,
                    "mode": mode,
                    "k": k,
                    "reasoningProfile": profile,
                    "tokenEfficiency": {
                        "totalActualTokens": None,
                        "totalUnoptimizedTokens": None,
                        "totalTokensSaved": 0,
                        "totalTokensSavedPct": 0.0,
                    },
                    "snapshotLock": compact_lock,
                    "winner": {
                        **winner.to_dict(),
                        "passed_verification": False,
                        "verification_score": 0.0,
                        "score": 0.0,
                    },
                    "allProbeResults": [r.to_dict() for r in probe_results],
                    "recordedExperience": None,
                }

            total_actual_tokens = sum(r.total_tokens for r in probe_results)
            has_complete_usage = all(getattr(r, "usage_complete", False) for r in active_results)
            total_unoptimized_tokens = 16700 * k if is_simulated_run or total_actual_tokens > 0 else 0
            total_saved = max(0, total_unoptimized_tokens - total_actual_tokens)
            total_saved_pct = (
                round((total_saved / max(1, total_unoptimized_tokens)) * 100.0, 1)
                if total_unoptimized_tokens > 0
                else 0.0
            )

            recorded_info = None
            eval_receipt_id = None
            if record_to_library:
                if not is_simulated_run and winner.passed_verification and winner.verifier_executed:
                    rcpt_res = self.create_evaluation_receipt(
                        {
                            "taskId": task_id,
                            "candidateId": winning_spec.candidate_id,
                            "domain": domain,
                            "evaluatorId": "python-benchmark-adapter",
                            "artifactHashes": dict(winner.artifact_hashes or {}),
                            "checks": [
                                {
                                    "name": "benchmark_adapter_score",
                                    "passed": True,
                                    "score": winner.verification_score,
                                }
                            ],
                            "score": winner.verification_score,
                            "passed": True,
                            "actualTokens": total_actual_tokens if (has_complete_usage and total_actual_tokens > 0) else None,
                            "synthetic": False,
                        }
                    )
                    eval_receipt_id = rcpt_res.get("receiptId")
                rec_status = "active" if (not is_simulated_run and eval_receipt_id) else "candidate"
                recorded_info = self.record_experience(
                    {
                        "task_id": task_id,
                        "domain": domain,
                        "title": f"EXPERIENCE: {task_id} ({winning_spec.candidate_id} · {total_saved_pct}% Tokens Saved)",
                        "cue": (
                            f"When tackling '{problem[:80]}' in {domain}, use {winning_spec.candidate_id} "
                            f"(depth={profile['reasoning_depth']}, thinkingCap={thinking_cap}, model={model_tier}) "
                            f"with branched subagents and snapshot isolation."
                        ),
                        "problem": problem,
                        "observed_behavior": (
                            f"Compared K={k} candidates ({mode}, depth={profile['reasoning_depth']}) under snapshot lock {snapshot_id}. "
                            f"Winning candidate '{winner.candidate_id}' achieved score={winner.verification_score} "
                            f"with {winner.tool_errors} tool errors using {total_actual_tokens} total tokens "
                            f"({total_saved_pct}% saved vs unbounded baseline)."
                        ),
                        "supporting_evidence": winner.evidence_paths,
                        "status": rec_status,
                        "synthetic": is_simulated_run,
                        "evaluation_receipt": eval_receipt_id,
                        "adopted_harness": {
                            **winning_spec.to_dict(),
                            "status": rec_status,
                            "synthetic": is_simulated_run,
                            "reasoning_profile": profile,
                            "token_efficiency": {
                                "total_actual_tokens": total_actual_tokens if (is_simulated_run or has_complete_usage) else None,
                                "total_unoptimized_tokens": total_unoptimized_tokens if is_simulated_run else None,
                                "total_tokens_saved": total_saved if is_simulated_run else None,
                                "total_tokens_saved_pct": total_saved_pct if is_simulated_run else None,
                            },
                        },
                    }
                )

            winner_dict = winner.to_dict()
            winner_dict["score"] = winner.verification_score
            return {
                "ok": True,
                "status": "simulated" if is_simulated_run else "succeeded",
                "execution_mode": "simulation" if is_simulated_run else "verified",
                "executionMode": "simulation" if is_simulated_run else "verified",
                "synthetic": is_simulated_run,
                "eval_receipt_id": eval_receipt_id,
                "evalReceiptId": eval_receipt_id,
                "task_id": task_id,
                "domain": domain,
                "mode": mode,
                "k": k,
                "reasoningProfile": profile,
                "tokenEfficiency": {
                    "totalActualTokens": total_actual_tokens if (is_simulated_run or has_complete_usage) else None,
                    "totalUnoptimizedTokens": total_unoptimized_tokens if is_simulated_run else None,
                    "totalTokensSaved": total_saved,
                    "totalTokensSavedPct": total_saved_pct,
                },
                "snapshotLock": compact_lock,
                "winner": winner_dict,
                "allProbeResults": [r.to_dict() for r in probe_results],
                "recordedExperience": recorded_info,
                "experience_record": recorded_info,
            }
        finally:
            if lock and lock.get("ok") is not False and lock.get("snapshotId"):
                self.release_snapshot_lock(owner_run_id=owner_run_id, snapshot_id=snapshot_id)
                if not record_to_library:
                    snap_file = self.workspace_root / ".harness" / "snapshots" / f"{snapshot_id}.json"
                    if snap_file.exists():
                        snap_file.unlink()

    def run_loop(
        self,
        task_id: str = "task-loop",
        domain: str = "software-engineering",
        problem: str = "",
        k: int = 2,
        mode: str = "parallel",
        record_to_library: bool = True,
        allow_simulation: bool = False,
        command: Optional[Union[str, List[str]]] = None,
        required_files: Optional[List[str]] = None,
        validator_cmd: Optional[Union[str, List[str]]] = None,
    ) -> Dict[str, Any]:
        """Alias for `run_propose_probe_compose` defaulting to `allow_simulation=False`."""
        return self.run_propose_probe_compose(
            task_id=task_id,
            domain=domain,
            problem=problem,
            k=k,
            mode=mode,
            record_to_library=record_to_library,
            allow_simulation=allow_simulation,
            command=command,
            required_files=required_files,
            validator_cmd=validator_cmd,
        )


def build_sdk_agent_config(
    workspace_root: Optional[Union[str, Path]] = None,
    model: str = "auto",
    candidate: Optional[HarnessCandidateSpec] = None,
    snapshot_id: str = "SNAP-PUBLIC",
    task_id: str = "task-probe",
) -> Dict[str, Any]:
    ex = AntigravityExecutor(workspace_root or Path.cwd())
    cand = candidate or HarnessCandidateSpec(
        candidate_id="CAND-SDK",
        hypothesis="Public SDK config",
        model_tier=model,
    )
    return ex.build_sdk_agent_config(cand, snapshot_id, task_id=task_id)


def validate_sdk_agent_config(config_dict: Mapping[str, Any]) -> Dict[str, Any]:
    unknown = [
        k for k in config_dict.keys() if k not in AntigravityExecutor.PUBLIC_SDK_LOCAL_AGENT_CONFIG_FIELDS
    ]
    return {
        "ok": len(unknown) == 0,
        "unknown_fields": unknown,
        "unsupported_keys": unknown,
        "allowed_fields": list(AntigravityExecutor.PUBLIC_SDK_LOCAL_AGENT_CONFIG_FIELDS),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Harness² Antigravity Executor Adapter (Token-Efficient)")
    parser.add_argument("--task-id", default="task-demo-verification", help="Task identifier")
    parser.add_argument("--domain", default="software-engineering", help="Domain library")
    parser.add_argument(
        "--problem",
        default="What evidence supported our previous choice of memory architecture and how should subagent probes be isolated?",
        help="Problem statement to probe",
    )
    parser.add_argument("--k", type=int, default=2, help="Number of candidate harnesses to probe")
    parser.add_argument("--mode", choices=["parallel", "sequential"], default="parallel")
    parser.add_argument(
        "--reasoning-depth",
        choices=["eco", "balanced", "deep"],
        default="balanced",
        help="Reasoning depth & token budget preset (eco=~71%% saved, balanced=~53%% saved, deep=complex)",
    )
    parser.add_argument("--thinking-budget", type=int, default=None, help="Override max thinking tokens per turn")
    parser.add_argument("--max-steps", type=int, default=None, help="Override max probe steps per candidate")
    parser.add_argument(
        "--prober-model",
        default=None,
        help="Override subagent prober model tier (flash_lite, flash, inherit, pro)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run a non-mutating self-test (does not write a permanent experience entry)",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Allow simulated demo probing without external provider credentials",
    )
    args = parser.parse_args()

    executor = AntigravityExecutor(
        Path.cwd(),
        reasoning_depth=args.reasoning_depth,
        thinking_budget_tokens=args.thinking_budget,
        max_probe_steps=args.max_steps,
        prober_model_tier=args.prober_model,
    )
    allow_sim = bool(args.self_test or args.demo)
    summary = executor.run_propose_probe_compose(
        task_id=args.task_id,
        domain=args.domain,
        problem=args.problem,
        k=args.k,
        mode=args.mode,
        record_to_library=not args.self_test,
        allow_simulation=allow_sim,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
