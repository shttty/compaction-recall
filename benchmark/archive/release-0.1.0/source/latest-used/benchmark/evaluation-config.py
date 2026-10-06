"""Strict external configuration and allowlisted historical helper extraction."""
import ast
import datetime
import hashlib
import json
import math
import pathlib
import re
import types
import uuid

FUNCTIONS = {"parse_date", "iso", "build_session", "chunk_cuts", "jsonl_lines", "append_entries"}
CONSTANTS = {"DEV8", "ASK", "_BASE", "_STEPS", "_TAIL", "JUDGE", "ABSTAIN", "CHARS_PER_TOKEN"}


def load_helper(path, config):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    selected, found = [], set()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            defaults = node.args.defaults + [x for x in node.args.kw_defaults if x is not None]
            arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
            arguments += [arg for arg in (node.args.vararg, node.args.kwarg) if arg is not None]
            if (node.name in found or node.decorator_list or node.returns is not None or
                    any(arg.annotation is not None for arg in arguments) or
                    any(not isinstance(x, ast.Constant) for x in defaults)):
                raise ValueError(f"Unsupported helper definition: {node.name}")
            selected.append(node); found.add(node.name)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in CONSTANTS:
                if name in found:
                    raise ValueError(f"Duplicate helper definition: {name}")
                allowed = (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.Load, ast.Name,
                           ast.BinOp, ast.Add, ast.Mult, ast.JoinedStr, ast.FormattedValue)
                if any(not isinstance(part, allowed) or (isinstance(part, ast.Name) and part.id not in CONSTANTS)
                       for part in ast.walk(node.value)):
                    raise ValueError(f"Unsupported helper constant: {name}")
                selected.append(node); found.add(name)
    if found != FUNCTIONS | CONSTANTS:
        raise ValueError(f"Unsupported helper shape; missing {sorted((FUNCTIONS | CONSTANTS) - found)}")
    namespace = {"json": json, "uuid": uuid, "datetime": datetime.datetime, "timezone": datetime.timezone,
                 "timedelta": datetime.timedelta, "Path": pathlib.Path, "pathlib": pathlib, "re": re,
                 "math": math, "RUNS": pathlib.Path(config["output_dir"]), "MODEL": config["compression"]["model"]}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)
    return types.SimpleNamespace(**namespace)


def exact_fields(value, names, label):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError(f"{label} requires exactly: {', '.join(sorted(names))}")


def load(path, root):
    source = pathlib.Path(path).resolve(strict=True)
    config = json.loads(source.read_text(encoding="utf-8"))
    path_fields = ("sdk_path", "helper_path", "data_path", "output_dir", "candidate_repo")
    phases = ("compression", "answer", "judge")
    exact_fields(config, (*path_fields, "system_prompt", "protocol", *phases), "config")
    def resolve(value):
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Config paths must be nonempty strings")
        return str((source.parent / value).resolve())
    for key in path_fields:
        config[key] = resolve(config[key])
    if not isinstance(config["system_prompt"], str):
        raise ValueError("system_prompt must be a string")
    exact_fields(config["protocol"], ("segments", "reserve_tokens", "overhead_tokens"), "protocol")
    for key, value in config["protocol"].items():
        if type(value) is not int or value < (2 if key == "segments" else 0):
            raise ValueError(f"Invalid protocol {key}")
    required = [source, pathlib.Path(config["helper_path"]), pathlib.Path(config["data_path"]),
                pathlib.Path(config["sdk_path"]) / "package.json"]
    protected = [root, source, *(pathlib.Path(config[key]) for key in path_fields if key != "output_dir")]
    for phase in phases:
        exact_fields(config[phase], ("provider", "model", "effort", "profile"), phase)
        if any(not isinstance(value, str) or not value.strip() for value in config[phase].values()):
            raise ValueError(f"Invalid phase strings: {phase}")
        config[phase]["profile"] = resolve(config[phase]["profile"])
        profile = pathlib.Path(config[phase]["profile"])
        protected.append(profile)
        required.extend(profile / name for name in ("models.json", "auth.json"))
    output = pathlib.Path(config["output_dir"])
    if any(output == item or output in item.parents or item in output.parents for item in protected):
        raise ValueError("output_dir must be external and must not overlap any input")
    for item in required:
        if not item.is_file():
            raise ValueError(f"Required input file missing: {item}")
    if not pathlib.Path(config["candidate_repo"]).is_dir():
        raise ValueError("candidate_repo must exist")
    helper = load_helper(pathlib.Path(config["helper_path"]), config)
    sources = [root / "benchmark" / name for name in ("evaluate.py", "evaluation-config.py", "sdk-rpc.mjs",
               "pi-rpc-observer.py", "pi-context-estimate.mjs", "grep-only-adapter.mjs")]
    sources.append(root / "package-lock.json")
    hashes = {}
    for item in required + sources:
        digest = hashlib.sha256()
        with item.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        hashes[str(item)] = digest.hexdigest()
    identity = {"schema": "pi-evaluation-v3", "config_path": str(source), "config": config,
                "files": hashes}
    return config, helper, identity
