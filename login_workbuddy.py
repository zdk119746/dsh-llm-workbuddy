#!/usr/bin/env python3
"""Standalone WorkBuddy/CodeBuddy CN OAuth login.

Implements the device flow exactly like the official CodeBuddy plugin
(platform=CLI, Origin/Referer codebuddy.cn, CLI User-Agent), as verified by
the Sliverkiss/workbuddy2api Go login tool. Writes a session file in the
format the hawklithm/workbuddy2api Python proxy reads:
{ "auth": {accessToken, refreshToken, expiresIn, domain}, "account": {...}, "machineId": "..." }

Usage:
  python3 login_workbuddy.py [--session-file PATH] [--timeout 300]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "https://copilot.tencent.com"
PLATFORM = "CLI"
CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2"
ORIGIN = "https://www.codebuddy.cn"


def common_headers(req: urllib.request.Request) -> None:
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/plain, */*")
    req.add_header("X-Requested-With", "XMLHttpRequest")
    req.add_header("Origin", ORIGIN)
    req.add_header("Referer", ORIGIN + "/")
    req.add_header("User-Agent", CLIENT_UA)


def do(method: str, path: str, *, auth: str | None = None, body: dict | None = None) -> tuple[dict, int]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    url = BASE + path
    req = urllib.request.Request(url, data=data, method=method)
    common_headers(req)
    if auth:
        req.add_header("Authorization", f"Bearer {auth}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {path}: {detail[:400]}") from exc


def unwrap(payload: dict) -> dict:
    """{code, msg, data} envelope."""
    if payload.get("code") not in (0, None):
        raise RuntimeError(f"business code={payload.get('code')} msg={payload.get('msg')}")
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-file", default=str(pathlib.Path.home() / ".codebuddy-session.json"))
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    session_file = pathlib.Path(args.session_file)

    state_payload, _ = do("POST", f"/v2/plugin/auth/state?platform={PLATFORM}", body={})
    st = unwrap(state_payload)
    state = st.get("state")
    auth_url = st.get("authUrl")
    if not state or not auth_url:
        raise RuntimeError(f"auth/state missing state/authUrl: {st!r}")

    print("请在浏览器中打开以下链接，用你的 WorkBuddy/CodeBuddy 账号完成登录：")
    print(f"\n  {auth_url}\n")

    deadline = time.monotonic() + args.timeout
    token = None
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            tok, _ = do("GET", f"/v2/plugin/auth/token?state={state}")
        except RuntimeError:
            continue
        if isinstance(tok.get("data"), dict) and tok["data"].get("accessToken"):
            token = tok["data"]
            break
    if token is None:
        print("登录超时，请重试。", file=sys.stderr)
        return 1

    access = token.get("accessToken", "")
    account: dict = {}
    try:
        acct, _ = do("GET", f"/v2/plugin/login/account?state={state}", auth=access)
        if isinstance(acct.get("data"), dict):
            account = acct["data"]
    except RuntimeError as exc:
        print(f"(warn) login/account skipped: {exc}", file=sys.stderr)

    session = {
        "auth": {
            "accessToken": access,
            "refreshToken": token.get("refreshToken", ""),
            "expiresIn": token.get("expiresIn"),
            "expiresAt": int(time.time() * 1000) + int(token.get("expiresIn", 0) or 0) * 1000,
            "domain": token.get("domain", ""),
        },
        "account": account,
        "machineId": str(uuid.uuid4()),
    }
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_text(json.dumps(session, ensure_ascii=False, indent=2))
    print(f"\n登录成功，会话已保存: {session_file}")
    print(f"用户: {account.get('nickname') or account.get('uid') or '<unknown>'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
