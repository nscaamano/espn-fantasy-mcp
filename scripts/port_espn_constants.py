"""Port espn-api football/constant.py to TypeScript without executing it.

Usage (from a clone of cwendt94/espn-api):
  python3 -I /path/to/espn-fantasy-mcp/scripts/port_espn_constants.py \
    espn_api/football/constant.py "$(git log -1 --format=%h)" \
    > /path/to/espn-fantasy-mcp/packages/espn-client/src/constants.ts
"""
import ast, json, sys

src_path, commit = sys.argv[1], sys.argv[2]
tree = ast.parse(open(src_path).read())
values = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
        values[node.targets[0].id] = ast.literal_eval(node.value)

def num_map(d):
    return {k: v for k, v in d.items() if isinstance(k, int)}
def str_map(d):
    return {k: v for k, v in d.items() if isinstance(k, str)}

def ts_record(name, d, vtype, comment):
    lines = [f"/** {comment} */", f"export const {name}: Readonly<Record<{'number' if all(isinstance(k,int) for k in d) else 'string'}, {vtype}>> = {{"]
    for k, v in d.items():
        key = k if isinstance(k, int) else json.dumps(k)
        lines.append(f"  {key}: {json.dumps(v) if not isinstance(v, dict) else '{ abbr: ' + json.dumps(v['abbr']) + ', label: ' + json.dumps(v['label']) + ' }'},")
    lines.append("};")
    return "\n".join(lines)

out = [
    "// Ported from cwendt94/espn-api espn_api/football/constant.py",
    f"// Source commit: {commit}",
    "// Regenerate rather than hand-edit, so diffs against upstream stay a straight port.",
    "",
    ts_record("POSITION_MAP", num_map(values["POSITION_MAP"]), "string", "Lineup slot / eligible slot id → label."),
    "",
    ts_record("POSITION_ID_BY_NAME", str_map(values["POSITION_MAP"]), "number", "Position label → slot id, used for free-agent slot filters."),
    "",
    ts_record("PRO_TEAM_MAP", values["PRO_TEAM_MAP"], "string", "ESPN pro team id → abbreviation."),
    "",
    ts_record("ACTIVITY_MAP", num_map(values["ACTIVITY_MAP"]), "string", "Recent-activity messageTypeId → action."),
    "",
    ts_record("ACTIVITY_ID_BY_NAME", str_map(values["ACTIVITY_MAP"]), "number", "Activity name → messageTypeId."),
    "",
    ts_record("PLAYER_STATS_MAP", values["PLAYER_STATS_MAP"], "string", "Stat id → stat name (player stat breakdowns)."),
    "",
    ts_record("SETTINGS_SCORING_FORMAT_MAP", values["SETTINGS_SCORING_FORMAT_MAP"], "{ abbr: string; label: string }", "Scoring settings stat id → abbreviation and label."),
    "",
    "export const TRANSACTION_TYPES: readonly string[] = " + json.dumps(sorted(values["TRANSACTION_TYPES"])) + ";",
    "",
]
print("\n".join(out))
