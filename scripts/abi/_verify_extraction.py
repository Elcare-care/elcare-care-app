"""Temporary cross-check of check-abi-compatibility.mjs extraction logic (node unavailable)."""
import re, json, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def find_matching_brace(src, open_idx):
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{': depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0: return i
    return -1

def extract_version(src):
    m = re.search(r'const\s+CONTRACT_VERSION\s*:\s*&str\s*=\s*"([^"]+)"', src)
    return m.group(1) if m else None

def extract_errors(src):
    idx = src.find('#[contracterror]')
    if idx == -1: return []
    enum_idx = src.find('pub enum', idx)
    brace = src.find('{', enum_idx)
    close = find_matching_brace(src, brace)
    body = src[brace+1:close]
    return [(m.group(1), int(m.group(2))) for m in
            re.finditer(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?', body, re.M)]

def extract_methods(src):
    methods, search_from = [], 0
    while True:
        attr = src.find('#[contractimpl]', search_from)
        if attr == -1: break
        search_from = attr + len('#[contractimpl]')
        impl_idx = src.find('impl', search_from)
        brace = src.find('{', impl_idx)
        close = find_matching_brace(src, brace)
        body = src[brace+1:close]
        for m in re.finditer(r'^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', body, re.M):
            depth = 1
            for ch in body[:m.start()]:
                if ch == '{': depth += 1
                elif ch == '}': depth -= 1
            if depth == 1:
                methods.append(m.group(1))
        search_from = close + 1
    return sorted(set(methods))

abi = json.load(open(os.path.join(ROOT, 'packages', 'contract-abi', 'abi.json')))

for key, rust_file in [('marketplace', 'contracts/soroban-marketplace/src/contract.rs'),
                       ('launchpad', 'contracts/launchpad/src/contract.rs')]:
    src = open(os.path.join(ROOT, rust_file), encoding='utf-8').read()
    ver = extract_version(src)
    errs = extract_errors(src)
    methods = extract_methods(src)
    abi_c = abi['contracts'][key]
    print(f"=== {key} ===")
    print(f"  rust version={ver}  abi version={abi_c['version']}  sync={ver == abi_c['version']}")
    print(f"  rust errors={len(errs)} (max code {max(c for _, c in errs) if errs else '-'})  abi errors={len(abi_c.get('errors', {}))}")
    abi_err_names = set(abi_c.get('errors', {}).keys())
    missing_e = [n for n, _ in errs if n not in abi_err_names]
    stale_e = [n for n in abi_err_names if n not in {n for n, _ in errs}]
    print(f"  errors missing in abi ({len(missing_e)}): {missing_e[:8]}{'...' if len(missing_e) > 8 else ''}")
    print(f"  errors stale in abi ({len(stale_e)}): {stale_e[:8]}")
    abi_m = [m['name'] for m in abi_c.get('methods', [])]
    missing_m = [m for m in methods if m not in set(abi_m)]
    stale_m = [m for m in abi_m if m not in set(methods)]
    print(f"  rust methods={len(methods)}  abi methods={len(abi_m)}")
    print(f"  methods missing in abi ({len(missing_m)}): {missing_m[:10]}{'...' if len(missing_m) > 10 else ''}")
    print(f"  methods stale in abi ({len(stale_m)}): {stale_m[:10]}")
    print()