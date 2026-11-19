-- Lua guard of the compilation sandbox, run by LuaLaTeX before the first line of the document
-- (latexmk -pretex, see compile.sh). LuaTeX's Lua file functions ignore openin_any: without it
-- \directlua could read any file of the container (/etc/passwd, /proc/self/environ). Reads are
-- limited to the project (/work), the TeX Live trees, the font caches and the font
-- configuration. TeX Live's restricted mode (luatex-core.lua) has already removed ffi, debug,
-- C libraries and the commands outside shell_escape_commands. Not loaded with `lualatex --lua`:
-- in that mode luatex-core.lua does not apply its restrictions (ffi stays available).

local open, lines, input, output, loadfile_, dofile_ = io.open, io.lines, io.input, io.output, loadfile, dofile
local find, sub = string.find, string.sub

local ALLOWED_PREFIXES = {
  '/work/',
  '/usr/local/texlive/',
  '/usr/share/fonts/',
  '/usr/local/share/fonts/',
  '/etc/fonts/',
  '/tmp/texmf-var/',
  '/opt/integris/texmf-var/',
}

-- A path is allowed when it has no ".." segment and is relative to the project (the current
-- directory, /work) or under one of the prefixes above.
local function allowed(path)
  if type(path) ~= 'string' or path == '' or find(path, '\0', 1, true) then return false end
  if path == '..' or find(path, '^%.%./') or find(path, '/%.%./') or find(path, '/%.%.$') then
    return false
  end
  if sub(path, 1, 1) ~= '/' then return not find(path, '^~') end
  for _, prefix in ipairs(ALLOWED_PREFIXES) do
    if sub(path, 1, #prefix) == prefix then return true end
  end
  return false
end

local function refuse(path)
  return nil, 'Not reading from ' .. tostring(path) .. ' (Integris sandbox)'
end

io.open = function(path, mode)
  if not allowed(path) then return refuse(path) end
  return open(path, mode)
end
io.lines = function(path, ...)
  if path ~= nil and not allowed(path) then error('Not reading from ' .. tostring(path) .. ' (Integris sandbox)', 2) end
  return lines(path, ...)
end
io.input = function(file)
  if type(file) == 'string' and not allowed(file) then error('Not reading from ' .. file .. ' (Integris sandbox)', 2) end
  return input(file)
end
io.output = function(file)
  if type(file) == 'string' and not allowed(file) then error('Not writing to ' .. file .. ' (Integris sandbox)', 2) end
  return output(file)
end
loadfile = function(path, ...)
  if path == nil or not allowed(path) then return refuse(path) end
  return loadfile_(path, ...)
end
dofile = function(path)
  if path == nil or not allowed(path) then error('Not reading from ' .. tostring(path) .. ' (Integris sandbox)', 2) end
  return dofile_(path)
end
-- `load` keeps accepting bytecode: luaotfload loads its caches with it. Crafted bytecode could
-- corrupt memory; that stays inside the gVisor sandbox, where the file permissions of the image
-- (docker/texlive/Dockerfile) are the boundary, not this script.

local function guard(library, names)
  if type(library) ~= 'table' then return end
  for _, name in ipairs(names) do
    local original = library[name]
    if type(original) == 'function' then
      library[name] = function(path, ...)
        local file = type(path) == 'table' and path.filename or path
        if not allowed(file) then return refuse(file) end
        return original(path, ...)
      end
    end
  end
end
guard(lfs, { 'dir', 'attributes', 'symlinkattributes', 'touch', 'mkdir', 'rmdir', 'chdir' })
-- A link is checked at both ends.
if type(lfs) == 'table' and type(lfs.link) == 'function' then
  local link = lfs.link
  lfs.link = function(target, name, ...)
    if not allowed(target) or not allowed(name) then return refuse(target) end
    return link(target, name, ...)
  end
end
guard(os, { 'remove', 'rename' })
guard(pdfe, { 'open' })
guard(epdf, { 'open' })
guard(fontloader, { 'open', 'info' })
guard(img, { 'scan', 'new' })

-- luatex-core.lua keeps the unrestricted io.lines here.
io.saved_lines = nil
local handle = getmetatable(io.stderr)
if handle then handle.saved_lines = nil end

-- No way back to the original functions, and no native code.
debug = nil
package.loaded.debug = nil
package.loadlib = nil
package.cpath = ''
if package.searchers then
  package.searchers[3] = nil
  package.searchers[4] = nil
end
package.preload.ffi = nil
ffi = nil
