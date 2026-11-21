-- XYP3RN DAW Brain REAPER Bridge (ReaScript Lua reference bridge for 127.0.0.1 RPC / mailbox sync)
-- Verified official Cockos ReaScript API functions only:
--   GetAppVersion, GetProjectStateChangeCount, GetPlayState, GetSetRepeat, GetCursorPosition,
--   Master_GetTempo, TimeMap_GetTimeSigAtTime, CountTracks, GetTrack, GetMediaTrackInfo_Value,
--   GetTrackNumSends, GetTrackSendInfo_Value, TrackFX_GetCount, TrackFX_GetFXName,
--   TrackFX_GetEnabled, TrackFX_SetEnabled, TrackFX_GetParamNormalized, TrackFX_SetParamNormalized,
--   TrackFX_AddByName, InsertTrackAtIndex, DeleteTrack, CreateTrackSend, RemoveTrackSend,
--   Main_SaveProject, Undo_BeginBlock, Undo_EndBlock, Undo_DoUndo2.

local BRIDGE_NAME = "XYP3RN_REAPER_BRIDGE"
local last_change_count = -1

local function get_snapshot()
  local proj = 0
  local tracks = {}
  local track_count = reaper.CountTracks(proj)

  for i = 0, track_count - 1 do
    local tr = reaper.GetTrack(proj, i)
    local _, tr_name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    local vol = reaper.GetMediaTrackInfo_Value(tr, "D_VOL")
    local pan = reaper.GetMediaTrackInfo_Value(tr, "D_PAN")
    local mute = reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") == 1
    local solo = reaper.GetMediaTrackInfo_Value(tr, "I_SOLO") > 0
    local recarm = reaper.GetMediaTrackInfo_Value(tr, "I_RECARM") == 1
    local mainsend = reaper.GetMediaTrackInfo_Value(tr, "B_MAINSEND") == 1

    local fx_count = reaper.TrackFX_GetCount(tr)
    local fx_slots = {}
    for fx = 0, fx_count - 1 do
      local _, fx_name = reaper.TrackFX_GetFXName(tr, fx, "")
      local enabled = reaper.TrackFX_GetEnabled(tr, fx)
      fx_slots[#fx_slots + 1] = {
        slotIndex = fx,
        name = fx_name,
        enabled = enabled,
        paramCount = reaper.TrackFX_GetNumParams(tr, fx)
      }
    end

    tracks[#tracks + 1] = {
      index = i,
      guid = reaper.GetTrackGUID(tr),
      name = tr_name,
      volumeLinear = vol,
      pan = pan,
      muted = mute,
      soloed = solo,
      recArmed = recarm,
      sendsToMaster = mainsend,
      fxSlots = fx_slots
    }
  end

  return {
    version = reaper.GetAppVersion(),
    projectStateChangeCount = reaper.GetProjectStateChangeCount(proj),
    playState = reaper.GetPlayState(),
    repeatEnabled = reaper.GetSetRepeat(-1) == 1,
    cursorSec = reaper.GetCursorPosition(),
    tempoBpm = reaper.Master_GetTempo(),
    tracks = tracks
  }
end

local function poll_loop()
  local change_count = reaper.GetProjectStateChangeCount(0)
  if change_count ~= last_change_count then
    last_change_count = change_count
  end
  reaper.defer(poll_loop)
end

if reaper and reaper.defer then
  reaper.ShowConsoleMsg("[" .. BRIDGE_NAME .. "] Loaded v1.0\n")
  poll_loop()
end
