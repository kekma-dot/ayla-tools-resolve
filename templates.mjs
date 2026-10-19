// Fixed read-only programs. Model data is decoded as JSON, never program text.
const CONTEXT = `p = resolve.GetProjectManager().GetCurrentProject()
t = p.GetCurrentTimeline() if p else None
`;
const SNAPSHOT = `def snapshot():
    return {"project_id": p.GetUniqueId() if p else None, "timeline_id": t.GetUniqueId() if t else None, "timecode": t.GetCurrentTimecode() if t else None}
`;
const STATE = `def structure(timeline):
    tracks = []
    count = 0
    for kind in ["video", "audio", "subtitle"]:
        n = timeline.GetTrackCount(kind)
        if n > 32:
            raise ValueError("Too many tracks for copy qualification")
        for index in range(1, n + 1):
            clips = []
            for c in timeline.GetItemListInTrack(kind, index) or []:
                count += 1
                if count > 500:
                    raise ValueError("Too many clips for bounded snapshot")
                media = c.GetMediaPoolItem()
                clips.append([c.GetName(), c.GetStart(), c.GetEnd(), c.GetDuration(), media.GetMediaId() if media else None])
            tracks.append([kind, index, clips])
    return {"start": timeline.GetStartFrame(), "end": timeline.GetEndFrame(), "fps": timeline.GetSetting("timelineFrameRate"), "width": timeline.GetSetting("timelineResolutionWidth"), "height": timeline.GetSetting("timelineResolutionHeight"), "tracks": tracks, "markers": {str(int(k)) if int(k) == k else str(k): v for k, v in (timeline.GetMarkers() or {}).items()}}
if not p or not t or p.GetUniqueId() != args["project_id"] or t.GetUniqueId() != args["timeline_id"]:
    raise ValueError("Project/timeline changed; inspect again")
`;
const PROGRAMS = Object.freeze({
  state: `${CONTEXT}${STATE}
result = {"project_id": p.GetUniqueId(), "timeline_id": t.GetUniqueId(), "project_name": p.GetName(), "timeline_name": t.GetName(), "shape": structure(t)}
`,
  page: `${CONTEXT}
if not p or not t or p.GetUniqueId() != args["project_id"] or t.GetUniqueId() != args["timeline_id"]:
    raise ValueError("Project/timeline changed")
if not resolve.OpenPage(args["page"]) or resolve.GetCurrentPage() != args["page"]:
    raise ValueError("Page navigation readback failed")
result = {"page": resolve.GetCurrentPage(), "project_id": p.GetUniqueId(), "timeline_id": t.GetUniqueId()}
`,
  copy: `${CONTEXT}${STATE}
if structure(t) != args["expected"]:
    raise ValueError("Plan stale; source structure changed")
for i in range(1, p.GetTimelineCount() + 1):
    if p.GetTimelineByIndex(i).GetName() == args["name"]:
        raise ValueError("Copy name already exists; never overwrite")
def require_current(expected_timeline):
    active = resolve.GetProjectManager().GetCurrentProject()
    current = active.GetCurrentTimeline() if active else None
    if not active or not current or active.GetUniqueId() != p.GetUniqueId() or current.GetUniqueId() != expected_timeline.GetUniqueId():
        raise ValueError("Active project/timeline changed; stop operation")
require_current(t)
working = t.DuplicateTimeline(args["name"])
if not working or working.GetUniqueId() == t.GetUniqueId():
    raise ValueError("Duplicate failed; inspect before retry")
if structure(working) != args["expected"]:
    raise ValueError("Copy readback differs; retain partial copy")
if not p.SetCurrentTimeline(working):
    raise ValueError("Cannot activate working copy; retain it")
require_current(working)
for m in args["markers"]:
    if not working.AddMarker(m["frame"], "Blue", m["name"], m["note"], 1, args["operation_id"]):
        raise ValueError("Marker failed; retain partial copy")
after = structure(working)
expected = args["expected"]
if {k: v for k, v in after.items() if k != "markers"} != {k: v for k, v in expected.items() if k != "markers"} or structure(t) != expected:
    raise ValueError("Source/copy changed during operation; manual reconciliation required")
for m in args["markers"]:
    info = working.GetMarkers().get(m["frame"], {})
    if info.get("name") != m["name"] or info.get("note") != m["note"] or info.get("customData") != args["operation_id"]:
        raise ValueError("Marker readback failed")
require_current(working)
if not resolve.GetProjectManager().SaveProject():
    raise ValueError("Save failed; partial copy may exist")
require_current(working)
if p.GetCurrentTimeline().GetUniqueId() != working.GetUniqueId() or structure(t) != expected or structure(working) != after:
    raise ValueError("Post-save readback mismatch")
result = {"verified": True, "project_id": p.GetUniqueId(), "source_timeline_id": t.GetUniqueId(), "working_timeline_id": working.GetUniqueId(), "name": working.GetName(), "markers_added": len(args["markers"]), "saved": True, "limits": "Structure/marker readback only; shared media, grades and full visual/audio fidelity not certified"}
`,
  summary: `${CONTEXT}
result = {"product": resolve.GetProductName(), "version": resolve.GetVersionString(), "page": resolve.GetCurrentPage(), "project": {"name": p.GetName(), "id": p.GetUniqueId(), "timeline_count": p.GetTimelineCount()} if p else None, "timeline": {"name": t.GetName(), "id": t.GetUniqueId(), "start_frame": t.GetStartFrame(), "end_frame": t.GetEndFrame(), "timecode": t.GetCurrentTimecode(), "video_tracks": t.GetTrackCount("video"), "audio_tracks": t.GetTrackCount("audio"), "fps": t.GetSetting("timelineFrameRate"), "width": t.GetSetting("timelineResolutionWidth"), "height": t.GetSetting("timelineResolutionHeight")} if t else None}
`,
  track: `${CONTEXT}
if not p or not t:
    raise ValueError("No active timeline")
if p.GetUniqueId() != args["project_id"] or t.GetUniqueId() != args["timeline_id"]:
    raise ValueError("Project/timeline changed; inspect again")
if args["track_index"] > t.GetTrackCount(args["track_type"]):
    raise ValueError("Track does not exist")
items = t.GetItemListInTrack(args["track_type"], args["track_index"]) or []
result = {"project_id": p.GetUniqueId(), "timeline_id": t.GetUniqueId(), "track_type": args["track_type"], "track_index": args["track_index"], "total": len(items), "offset": args["offset"], "items": [{"id": c.GetUniqueId(), "name": c.GetName()[:256], "start_frame": c.GetStart(), "end_frame": c.GetEnd(), "duration_frames": c.GetDuration()} for c in items[args["offset"]:args["offset"]+args["limit"]]]}
`,
  preview: `${CONTEXT}${SNAPSHOT}
if not p or not t:
    raise ValueError("No active timeline")
if p.GetUniqueId() != args["project_id"] or t.GetUniqueId() != args["timeline_id"]:
    raise ValueError("Project/timeline changed; inspect again")
before = snapshot()
exported = p.ExportCurrentFrameAsStill(args["output"])
p2 = resolve.GetProjectManager().GetCurrentProject()
t2 = p2.GetCurrentTimeline() if p2 else None
if not p2 or not t2 or p2.GetUniqueId() != before["project_id"] or t2.GetUniqueId() != before["timeline_id"] or t2.GetCurrentTimecode() != before["timecode"]:
    raise ValueError("Context/playhead changed during export; discard preview")
result = {"exported": exported, "provenance": "resolve-current-frame-export", "snapshot": before, "color": "Resolve PNG export; display/color fidelity not calibrated", "limitations": "No source-media fallback. Composite fidelity requires live qualification; no claim of audio review."}
`,
});

export function validateRequest(mode, input = {}) {
  if (!Object.hasOwn(PROGRAMS, mode)) throw new Error('Unsupported read-only recipe');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected parameters');
  const allowed = mode === 'summary' ? [] : mode === 'track'
    ? ['project_id', 'timeline_id', 'track_type', 'track_index', 'offset', 'limit']
    : mode === 'copy' ? ['project_id', 'timeline_id', 'expected', 'name', 'markers', 'operation_id']
    : mode === 'page' ? ['project_id', 'timeline_id', 'page'] : ['project_id', 'timeline_id'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Unexpected parameter');
  if (mode === 'summary') return {};
  for (const key of ['project_id', 'timeline_id']) {
    if (typeof input[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input[key])) throw new Error(`Invalid ${key}`);
  }
  if (mode === 'preview' || mode === 'state') return { project_id: input.project_id, timeline_id: input.timeline_id };
  if (mode === 'page') {
    if (!['media', 'cut', 'edit', 'fusion', 'color', 'fairlight', 'deliver'].includes(input.page)) throw new Error('Invalid Resolve page');
    return { ...input };
  }
  if (mode === 'copy') {
    validateCopy(input);
    return structuredClone(input);
  }
  const args = { offset: 0, limit: 50, ...input };
  if (!['video', 'audio', 'subtitle'].includes(args.track_type)) throw new Error('Invalid track_type');
  for (const [key, min, max] of [['track_index', 1, 1024], ['offset', 0, 1000000], ['limit', 1, 100]]) {
    if (!Number.isSafeInteger(args[key]) || args[key] < min || args[key] > max) throw new Error(`Invalid ${key}`);
  }
  return args;
}

export function validateCopy(input) {
  if (!input.expected || !Number.isSafeInteger(input.expected.start) || !Number.isSafeInteger(input.expected.end) || input.expected.end <= input.expected.start || !Array.isArray(input.expected.tracks) || !input.expected.markers || typeof input.expected.markers !== 'object' || Array.isArray(input.expected.markers)) throw new Error('Invalid snapshot');
  if (Buffer.byteLength(JSON.stringify(input.expected)) > 90000) throw new Error('Snapshot too large');
  for (const [key, max] of [['name', 100], ['operation_id', 64]]) {
    if (typeof input[key] !== 'string' || !input[key].length || input[key].length > max || /[\x00-\x1f\x7f]/.test(input[key])) throw new Error('Invalid copy identity');
  }
  if (!Array.isArray(input.markers) || input.markers.length > 50) throw new Error('At most 50 markers');
  const frames = new Set();
  for (const m of input.markers) {
    if (!m || Object.keys(m).some(k => !['frame', 'name', 'note'].includes(k)) || !Number.isSafeInteger(m.frame) || m.frame < 0 || m.frame >= input.expected.end - input.expected.start || frames.has(m.frame) || Object.hasOwn(input.expected.markers, String(m.frame))) throw new Error('Invalid/conflicting relative marker frame');
    for (const [key, max] of [['name', 80], ['note', 250]]) if (typeof m[key] !== 'string' || m[key].length > max || /[\x00-\x1f\x7f]/.test(m[key])) throw new Error('Invalid marker text');
    frames.add(m.frame);
  }
}

export function makeScript(mode, args) {
  if (!Object.hasOwn(PROGRAMS, mode)) throw new Error('Unsupported read-only recipe');
  // JSON quoted twice is a Python string literal; retain Unicode code points in UTF-8.
  const literal = JSON.stringify(JSON.stringify(args));
  return `import json\nargs = json.loads(${literal})\n${PROGRAMS[mode]}`;
}
