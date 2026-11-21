# name=XYP3RN DAW Brain (Read-Only)
# url=https://github.com/xyp3rn/os3
# version=2025.1
#
# Phase 11 Read-Only FL Studio 2025 Controller Script.
# Strictly observation-only: uses zero write calls to transport, mixer, channels, plugins, or disk.

import json
import time

import channels
import device
import general
import mixer
import playlist
import plugins
import transport
import ui
import midi

SYSEX_START = 0xF0
SYSEX_END = 0xF7
MFR_ID = 0x7D
MAGIC_X = 0x58
MAGIC_Y = 0x59
PROTO_VER = 0x01
MAX_RAW_CHUNK = 180
SCRIPT_VERSION = '2025.1.0-readonly'

MSG_HELLO_REQ = 0x01
MSG_HELLO_RESP = 0x02
MSG_PING_REQ = 0x03
MSG_PING_RESP = 0x04
MSG_SNAPSHOT_REQ = 0x10
MSG_SNAPSHOT_RESP = 0x11
MSG_PARAMS_REQ = 0x12
MSG_PARAMS_RESP = 0x13
MSG_DIRTY_PUSH = 0x20
MSG_ERR_READ_ONLY = 0x7E
MSG_ERR_PROTOCOL = 0x7F

_rx_chunks = {}
_dirty_mask = 0
_last_dirty_flush_ms = 0
_tx_seq = 0
DIRTY_DEBOUNCE_MS = 45
DIRTY_WATCH_MASK = (
    midi.HW_Dirty_Mixer_Sel
    | midi.HW_Dirty_Mixer_Controls
    | midi.HW_Dirty_Patterns
    | midi.HW_Dirty_Tracks
    | midi.HW_Dirty_ControlValues
    | midi.HW_Dirty_Names
    | midi.HW_Dirty_LEDs
)


def _crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= (b & 0xFF) << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc & 0xFFFF


def _encode_7bit(raw_bytes):
    out = []
    n = len(raw_bytes)
    for i in range(0, n, 7):
        chunk = raw_bytes[i:i + 7]
        msbs = 0
        lows = []
        for j, b in enumerate(chunk):
            if b & 0x80:
                msbs |= (1 << j)
            lows.append(b & 0x7F)
        out.append(msbs & 0x7F)
        out.extend(lows)
    return out


def _decode_7bit(encoded):
    out = []
    n = len(encoded)
    for i in range(0, n, 8):
        msbs = encoded[i] & 0x7F
        group_len = min(7, n - i - 1)
        for j in range(group_len):
            low = encoded[i + 1 + j] & 0x7F
            high = 0x80 if (msbs & (1 << j)) else 0
            out.append(low | high)
    return bytes(out)


def _send_sysex(msg_type, seq, payload_obj):
    raw_json = json.dumps(payload_obj, separators=(',', ':')).encode('utf-8')
    chunk_total = max(1, (len(raw_json) + MAX_RAW_CHUNK - 1) // MAX_RAW_CHUNK)
    seq14 = seq & 0x3FFF

    for chunk_idx in range(chunk_total):
        start = chunk_idx * MAX_RAW_CHUNK
        raw_slice = raw_json[start:start + MAX_RAW_CHUNK]
        encoded_slice = _encode_7bit(raw_slice)
        header = [
            PROTO_VER & 0x7F,
            msg_type & 0x7F,
            (seq14 >> 7) & 0x7F,
            seq14 & 0x7F,
            (chunk_idx >> 7) & 0x7F,
            chunk_idx & 0x7F,
            (chunk_total >> 7) & 0x7F,
            chunk_total & 0x7F,
        ]
        crc = _crc16(header + encoded_slice)
        crc_bytes = [(crc >> 14) & 0x03, (crc >> 7) & 0x7F, crc & 0x7F]
        frame = bytes([SYSEX_START, MFR_ID, MAGIC_X, MAGIC_Y] + header + encoded_slice + crc_bytes + [SYSEX_END])
        device.midiOutSysex(frame)


def _safe_call(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _extract_version_info():
    full_ver = str(_safe_call(lambda: ui.getVersion(midi.VER_FullVersionAndEdition), '') or _safe_call(ui.getVersion, '25.1.6'))
    edition = 'Unknown'
    lower = full_ver.lower()
    if 'all plugins' in lower:
        edition = 'All Plugins Edition'
    elif 'signature' in lower:
        edition = 'Signature Bundle'
    elif 'producer' in lower:
        edition = 'Producer Edition'
    elif 'fruity' in lower:
        edition = 'Fruity Edition'
    elif 'trial' in lower:
        edition = 'Trial'

    maj = _safe_call(lambda: ui.getVersion(midi.VER_Major), 25)
    mnr = _safe_call(lambda: ui.getVersion(midi.VER_Minor), 1)
    rel = _safe_call(lambda: ui.getVersion(midi.VER_Release), 0)
    bld = _safe_call(lambda: ui.getVersion(midi.VER_Build), 0)
    numeric_ver = '%s.%s.%s.%s' % (maj, mnr, rel, bld)
    return numeric_ver, edition, full_ver


def _collect_hello():
    ver, edition, full_ver = _extract_version_info()
    return {
        'hostName': 'FL Studio',
        'fullVersionAndEdition': full_ver,
        'version': ver,
        'edition': edition,
        'apiVersion': int(_safe_call(general.getVersion, 20)),
        'ppq': int(_safe_call(general.getRecPPQ, 96)),
        'title': str(_safe_call(ui.getProgTitle, '') or ''),
        'scriptVersion': SCRIPT_VERSION,
        'readOnly': True,
    }


def _collect_snapshot(dirty_flags=None):
    ver, edition, full_ver = _extract_version_info()
    ch_count = int(_safe_call(channels.channelCount, 0) or 0)
    channels_out = []
    for i in range(ch_count):
        plugin_name = None
        plugin_param_count = None
        if _safe_call(lambda idx=i: plugins.isValid(idx, -1), False):
            plugin_name = _safe_call(lambda idx=i: plugins.getPluginName(idx, -1), None)
            plugin_param_count = _safe_call(lambda idx=i: plugins.getParamCount(idx, -1), 0)
        channels_out.append({
            'index': i,
            'name': str(_safe_call(lambda idx=i: channels.getChannelName(idx), 'Channel %d' % i)),
            'channelType': int(_safe_call(lambda idx=i: channels.getChannelType(idx), 0) or 0),
            'targetMixerIndex': _safe_call(lambda idx=i: channels.getTargetFxTrack(idx), None),
            'muted': bool(_safe_call(lambda idx=i: channels.isChannelMuted(idx), False)),
            'soloed': bool(_safe_call(lambda idx=i: channels.isChannelSolo(idx), False)),
            'pluginName': plugin_name,
            'pluginParamCount': plugin_param_count,
        })

    trk_count = min(int(_safe_call(mixer.trackCount, 0) or 0), 126)
    mixer_out = []
    for t in range(trk_count):
        routes = []
        for dst in range(trk_count):
            if dst != t and _safe_call(lambda s=t, d=dst: mixer.getRouteSendActive(s, d), False):
                routes.append(dst)
        plugs = []
        for slot in range(10):
            if _safe_call(lambda tr=t, sl=slot: plugins.isValid(tr, sl), False):
                plugs.append({
                    'slotIndex': slot,
                    'name': str(_safe_call(lambda tr=t, sl=slot: plugins.getPluginName(tr, sl), 'Plugin %d' % slot)),
                    'bypassed': None,
                    'mixLevel': None,
                    'paramCount': int(_safe_call(lambda tr=t, sl=slot: plugins.getParamCount(tr, sl), 0) or 0),
                })
        mixer_out.append({
            'index': t,
            'name': str(_safe_call(lambda tr=t: mixer.getTrackName(tr), 'Master' if t == 0 else 'Insert %d' % t)),
            'isMaster': (t == 0),
            'volumeNormalized': float(_safe_call(lambda tr=t: mixer.getTrackVolume(tr), 0.8) or 0.0),
            'panNormalized': float(_safe_call(lambda tr=t: mixer.getTrackPan(tr), 0.0) or 0.0),
            'muted': bool(_safe_call(lambda tr=t: mixer.isTrackMuted(tr), False)),
            'soloed': bool(_safe_call(lambda tr=t: mixer.isTrackSolo(tr), False)),
            'peakNormalized': _safe_call(lambda tr=t: mixer.getTrackPeaks(tr, midi.PEAK_LR), None),
            'routesToMaster': (0 in routes) if t > 0 else None,
            'routeTargets': routes,
            'plugins': plugs,
        })

    pl_count = int(_safe_call(playlist.trackCount, 0) or 0)
    pl_names = []
    for p in range(1, min(pl_count + 1, 65)):
        pl_names.append(str(_safe_call(lambda pi=p: playlist.getTrackName(pi), 'Track %d' % pi)))

    snap = {
        'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'title': str(_safe_call(ui.getProgTitle, '') or ''),
        'fullVersionAndEdition': full_ver,
        'version': ver,
        'edition': edition,
        'apiVersion': int(_safe_call(general.getVersion, 20)),
        'ppq': int(_safe_call(general.getRecPPQ, 96)),
        'playing': bool(_safe_call(transport.isPlaying, 0)),
        'recording': bool(_safe_call(transport.isRecording, 0)),
        'loopMode': 'pattern' if _safe_call(transport.getLoopMode, midi.SM_Song) == midi.SM_Pat else 'song',
        'songPosMs': float(_safe_call(lambda: transport.getSongPos(midi.SONGLENGTH_MS), 0) or 0),
        'songPosBeats': None,
        'tempoBpm': float(_safe_call(lambda: mixer.getCurrentTempo(0), 120000) or 120000) / 1000.0,
        'timeSignatureNumerator': None,
        'timeSignatureDenominator': None,
        'channels': channels_out,
        'mixerTracks': mixer_out,
        'playlistTrackCount': pl_count,
        'playlistTrackNames': pl_names,
    }
    if dirty_flags is not None:
        snap['dirtyFlags'] = dirty_flags
    return snap


def _collect_params(req_obj):
    kind = req_obj.get('containerKind', 'mixer')
    idx = int(req_obj.get('containerIndex', 0))
    slot = int(req_obj.get('slotIndex', 0 if kind == 'mixer' else -1))
    max_params = min(int(req_obj.get('maxParams', 32)), 64)
    if not _safe_call(lambda: plugins.isValid(idx, slot), False):
        return []
    plug_name = str(_safe_call(lambda: plugins.getPluginName(idx, slot), 'Plugin'))
    total = min(int(_safe_call(lambda: plugins.getParamCount(idx, slot), 0) or 0), max_params)
    out = []
    for pi in range(total):
        out.append({
            'containerKind': kind,
            'containerIndex': idx,
            'slotIndex': slot,
            'pluginName': plug_name,
            'paramIndex': pi,
            'name': str(_safe_call(lambda p=pi: plugins.getParamName(p, idx, slot), 'Param %d' % pi)),
            'valueNormalized': float(_safe_call(lambda p=pi: plugins.getParamValue(p, idx, slot), 0.0) or 0.0),
            'displayValue': str(_safe_call(lambda p=pi: plugins.getParamValueString(p, idx, slot), '') or ''),
        })
    return out


def OnInit():
    print('[XYP3RN DAW Brain Read-Only] Initialized: %s (port=%s)' % (SCRIPT_VERSION, device.getPortNumber()))
    _send_sysex(MSG_HELLO_RESP, 0, _collect_hello())


def OnDeInit():
    print('[XYP3RN DAW Brain Read-Only] Deinitialized')


def OnRefresh(Flags):
    global _dirty_mask
    if Flags & DIRTY_WATCH_MASK:
        _dirty_mask |= (Flags & DIRTY_WATCH_MASK)


def OnProjectLoad(status):
    if status == midi.PL_LoadOk:
        global _tx_seq
        _tx_seq = (_tx_seq + 1) & 0x3FFF
        _send_sysex(MSG_DIRTY_PUSH, _tx_seq, _collect_snapshot(midi.HW_Dirty_Names))


def OnIdle():
    global _dirty_mask, _last_dirty_flush_ms, _tx_seq
    now_ms = int(time.monotonic() * 1000)
    if _dirty_mask != 0 and (now_ms - _last_dirty_flush_ms) >= DIRTY_DEBOUNCE_MS:
        mask = _dirty_mask
        _dirty_mask = 0
        _last_dirty_flush_ms = now_ms
        _tx_seq = (_tx_seq + 1) & 0x3FFF
        _send_sysex(MSG_DIRTY_PUSH, _tx_seq, _collect_snapshot(mask))


def OnSysEx(event):
    if not event.sysex or len(event.sysex) < 16:
        return
    frame = event.sysex
    if frame[0] != SYSEX_START or frame[-1] != SYSEX_END:
        return
    if frame[1] != MFR_ID or frame[2] != MAGIC_X or frame[3] != MAGIC_Y:
        return

    event.handled = True
    body_end = len(frame) - 4
    expected_crc = _crc16(frame[4:body_end])
    actual_crc = ((frame[body_end] & 0x03) << 14) | ((frame[body_end + 1] & 0x7F) << 7) | (frame[body_end + 2] & 0x7F)
    seq = ((frame[6] & 0x7F) << 7) | (frame[7] & 0x7F)

    if expected_crc != actual_crc:
        _send_sysex(MSG_ERR_PROTOCOL, seq, {'error': 'CRC_MISMATCH'})
        return

    msg_type = frame[5] & 0x7F
    chunk_idx = ((frame[8] & 0x7F) << 7) | (frame[9] & 0x7F)
    chunk_total = max(1, ((frame[10] & 0x7F) << 7) | (frame[11] & 0x7F))
    payload = _decode_7bit(frame[12:body_end])

    key = '%d:%d' % (msg_type, seq)
    entry = _rx_chunks.get(key)
    if entry is None or entry['total'] != chunk_total:
        entry = {'total': chunk_total, 'parts': {}}
        _rx_chunks[key] = entry
    entry['parts'][chunk_idx] = payload
    if len(entry['parts']) < chunk_total:
        return

    raw_full = b''.join(entry['parts'][i] for i in range(chunk_total))
    del _rx_chunks[key]
    req_obj = json.loads(raw_full.decode('utf-8')) if raw_full else {}

    if msg_type == MSG_HELLO_REQ:
        _send_sysex(MSG_HELLO_RESP, seq, _collect_hello())
    elif msg_type == MSG_PING_REQ:
        _send_sysex(MSG_PING_RESP, seq, {'pong': True, 'echoTs': req_obj.get('ts'), 'readOnly': True})
    elif msg_type == MSG_SNAPSHOT_REQ:
        _send_sysex(MSG_SNAPSHOT_RESP, seq, _collect_snapshot())
    elif msg_type == MSG_PARAMS_REQ:
        _send_sysex(MSG_PARAMS_RESP, seq, {'parameters': _collect_params(req_obj)})
    else:
        _send_sysex(MSG_ERR_READ_ONLY, seq, {
            'error': 'DAW_CAPABILITY_UNSUPPORTED',
            'reason': 'XYP3RN DAW Brain FL Studio script v1 is strictly read-only; write opcode 0x%02x refused' % msg_type,
        })
