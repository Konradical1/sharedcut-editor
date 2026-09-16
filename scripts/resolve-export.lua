-- Run in Resolve's Lua console:
-- dofile("/path/to/resolve-export.lua")("/absolute/existing/folder")
-- Only reads the current project and exports snapshots; no timeline or grade edits.
return function(out)
local r = resolve or Resolve()
assert(r, "Open a project in DaVinci Resolve first")
local p = r:GetProjectManager():GetCurrentProject()
assert(p, "Open a project first")
assert(out, "Pass an existing empty export folder")
local function json(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" or t == "number" then return tostring(v) end
  if t == "string" then
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
      return string.format('\\u%04x', string.byte(c))
    end) .. '"'
  end
  if t ~= "table" then return "null" end
  local a, count, array = {}, 0, true
  for k in pairs(v) do count = count + 1; if type(k) ~= "number" then array = false end end
  array = array and count > 0 and count == #v
  if array then for _, x in ipairs(v) do a[#a+1] = json(x) end
  else for k, x in pairs(v) do a[#a+1] = json(tostring(k)) .. ':' .. json(x) end end
  return (array and '[' or '{') .. table.concat(a, ',') .. (array and ']' or '}')
end
local doc = {format="frameline-resolve", version=1, resolveVersion=r:GetVersionString(), projectId=p:GetUniqueId(), name=p:GetName(), settings=p:GetSetting(), media={}, timelines={}}
local oldTimeline=p:GetCurrentTimeline()
local oldTimecode=oldTimeline and oldTimeline:GetCurrentTimecode()
local function timecode(frame, fps)
  local f=math.floor(fps+.5)
  return string.format('%02d:%02d:%02d:%02d',math.floor(frame/(f*3600)),math.floor(frame/(f*60))%60,math.floor(frame/f)%60,frame%f)
end
local function folder(f, name)
  for _, m in ipairs(f:GetClipList() or {}) do
    doc.media[#doc.media+1] = {id=m:GetUniqueId(), name=m:GetName(), bin=name, properties=m:GetClipProperty(), metadata=m:GetMetadata()}
  end
  for _, child in ipairs(f:GetSubFolderList() or {}) do folder(child, name .. '/' .. child:GetName()) end
end
folder(p:GetMediaPool():GetRootFolder(), "Master")
for index=1,p:GetTimelineCount() do
  local tl=p:GetTimelineByIndex(index)
  p:SetCurrentTimeline(tl)
  local t={id=tl:GetUniqueId(), name=tl:GetName(), startFrame=tl:GetStartFrame(), endFrame=tl:GetEndFrame(), startTimecode=tl:GetStartTimecode(), settings=tl:GetSetting(), markers=tl:GetMarkers(), tracks={}}
  for _, kind in ipairs({"video", "audio", "subtitle"}) do
    for track=1,tl:GetTrackCount(kind) do
      local tr={kind=kind, number=track, name=tl:GetTrackName(kind,track), enabled=tl:GetIsTrackEnabled(kind,track), items={}}
      for _, item in ipairs(tl:GetItemListInTrack(kind,track) or {}) do
        local media=item:GetMediaPoolItem()
        local i={id=item:GetUniqueId(), name=item:GetName(), startFrame=item:GetStart(true), endFrame=item:GetEnd(true), durationFrames=item:GetDuration(true), sourceStartFrame=item:GetSourceStartFrame(), sourceEndFrame=item:GetSourceEndFrame(), leftOffset=item:GetLeftOffset(), enabled=item:GetClipEnabled(), mediaId=media and media:GetUniqueId(), properties=item:GetProperty(), markers=item:GetMarkers(), nodes={}}
        if kind=="video" then
          local graph=item:GetNodeGraph()
          if graph then for n=1,graph:GetNumNodes() do i.nodes[#i.nodes+1]={index=n, name=graph:GetNodeLabel(n), tools=graph:GetToolsInNode(n), lut=graph:GetLUT(n)} end end
          i.lookFile=i.id..'.cube'
          i.lookExported=item:ExportLUT(r.EXPORT_LUT_65PTCUBE,out..'/'..i.lookFile)
          local referenceFrame=math.floor((i.startFrame+i.endFrame)/2)
          assert(tl:SetCurrentTimecode(timecode(referenceFrame,tonumber(t.settings.timelineFrameRate) or 24)), 'Could not seek reference frame')
          -- Resolve exports the last displayed GPU frame; allow the viewer to finish seeking.
          os.execute(package.config:sub(1,1)=='\\' and 'ping -n 2 127.0.0.1 > NUL' or 'sleep 0.3')
          i.referenceTimecode=tl:GetCurrentTimecode()
          i.referenceFrame=referenceFrame
          i.referenceFile=i.id..'.png'
          i.referenceExported=p:ExportCurrentFrameAsStill(out..'/'..i.referenceFile)
        end
        tr.items[#tr.items+1]=i
      end
      t.tracks[#t.tracks+1]=tr
    end
  end
  t.otioExported=tl:Export(out .. '/timeline-' .. index .. '.otio',r.EXPORT_OTIO)
  doc.timelines[#doc.timelines+1]=t
end
doc.projectExported=r:GetProjectManager():ExportProject(p:GetName(), out .. '/project.drp',true)
if oldTimeline then p:SetCurrentTimeline(oldTimeline); if oldTimecode then oldTimeline:SetCurrentTimecode(oldTimecode) end end
local f=assert(io.open(out .. '/project.frameline.json','w'))
f:write(json(doc));f:close()
print('SharedCut export complete: ' .. out .. '/project.frameline.json')
end
