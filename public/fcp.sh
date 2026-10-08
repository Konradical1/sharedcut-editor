#!/bin/zsh
# SharedCut — copy a Final Cut Pro project and every source file it uses to a drive or SD card.
#
#   zsh -c "$(curl -fsSL https://sharedcut.com/fcp.sh)"
#
# Reads the XML exported from Final Cut (File > Export XML…), finds each original file it references
# (inside the library or on other drives), and copies them with the XML into "SharedCut - <name>".
# Run it again to resume: finished files are skipped. Nothing on this Mac is changed or installed.
emulate -L zsh
setopt extended_glob no_nomatch
[[ -t 0 ]] || exec </dev/tty   # also works as `curl … | zsh`

die() { print -u2 -- "\n$*"; exit 1 }
human() { (( $1 >= 1e9 )) && printf '%.1f GB' $(( $1 / 1e9 )) || printf '%.0f MB' $(( $1 / 1e6 )) }
# Terminal escapes a dragged-in path (and adds a trailing space); undo both.
ask_path() { local answer; read -r "answer?$1"; answer=${answer%%[[:space:]]##}; print -r -- ${(Q)answer} }

print "\nSharedCut — copy a Final Cut project and its footage\n"
print "1. In Final Cut, select the project, then choose File > Export XML… and save it anywhere."
print "2. Drag the exported file into this window and press Return.\n"
xml=$(ask_path '> ')
bundle=''
[[ -d $xml && -f $xml/Info.fcpxml ]] && { bundle=$xml; xml=$xml/Info.fcpxml }
[[ -f $xml ]] || die "Can't find that file: $xml"
name=${${bundle:-$xml}:t:r}

# Every original file the XML points at: <media-rep src> (FCPXML 1.5+) and <asset src> (older).
typeset -U files
for src in ${(f)"$(xmllint --xpath "//media-rep[@kind='original-media']/@src | //asset/@src" $xml 2>/dev/null | grep -o 'src="[^"]*"')"}; do
  src=${${src#src=\"}%\"}
  src=${src//&apos;/\'}; src=${src//&quot;/\"}; src=${src//&lt;/<}; src=${src//&gt;/>}; src=${src//&amp;/&}
  [[ $src == file://* ]] || continue
  src=${${src#file://}#localhost}
  files+=("$(printf '%b' "${src//\%/\\x}")")
done
(( ${#files} )) || die "No source files found in that XML. Export the project with File > Export XML… and try again."

found=() sizes=() missing=() total=0
for f in $files; do
  if [[ -f $f ]]; then found+=($f); sizes+=($(stat -L -f %z -- $f)); (( total += sizes[-1] ))
  else missing+=($f); fi
done
print "\n$name: ${#found} source files, $(human $total)"
if (( ${#missing} )); then
  print "${#missing} files are offline on this Mac and will be skipped:"
  print -l -- "  "${^missing[1,10]}; (( ${#missing} > 10 )) && print "  …"
fi
(( ${#found} )) || die "None of the source files are on this Mac."

# Copy target: any mounted drive except this Mac's own disk, or a folder dragged in.
vols=()
for v in /Volumes/*(N/); do [[ $(stat -f %d $v) == $(stat -f %d /) ]] || vols+=($v); done
print "\nWhere should it go?"
for i in {1..${#vols}}; do (( ${#vols} )) && print "  $i) ${vols[i]:t} — $(human $(( $(df -k $vols[i] | awk 'NR==2{print $4}') * 1024 ))) free"; done
(( ${#vols} )) || print "  (no drive or SD card is plugged in)"
pick=$(ask_path "Type a number, or drag a folder here: ")
if [[ $pick == <1-> && -n ${vols[pick]} ]]; then root=$vols[pick]; else root=$pick; fi
[[ -d $root && -w $root ]] || die "Can't write to $root"
dest=$root/"SharedCut - $name"

# Names the SharedCut host (Windows) can open: no < > : " / \ | ? * or control characters, no trailing dot or space,
# no reserved device name. Same name from different folders, in any case (drives ignore case): keep both as
# "name (2).ext". Fixed by XML order, so a rerun maps identically.
typeset -A taken; names=()
for f in $found; do
  n=${${f:t}//[<>:\"\\\\|?*[:cntrl:]]/_}; n=${n%%[. ]##}; n=${n:-_}
  [[ ${(U)n:r} == (CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]) ]] && n="_$n"
  stem=${n:r} ext=${n:e} i=1
  while [[ -n ${taken[${(L)n}]} ]]; do (( i++ )); n="$stem ($i)${ext:+.$ext}"; done
  taken[${(L)n}]=1; names+=($n)
done

needed=0
for i in {1..${#found}}; do
  out=$dest/media/$names[i]
  [[ -f $out && $(stat -f %z -- $out) == $sizes[i] ]] || (( needed += sizes[i] ))
done
free=$(( $(df -k $root | awk 'NR==2{print $4}') * 1024 ))
(( needed < free )) || die "Not enough space on ${root:t}: needs $(human $needed), has $(human $free)."
# The file system of the folder itself, wherever it sits on the drive (df -T exits 0 only for that type).
if df -T msdos -- $root >/dev/null 2>&1; then
  for s in $sizes; do (( s < 4294967296 )) || die "${root:t} is formatted FAT32, which can't hold files over 4 GB. Use an exFAT or APFS drive."; done
fi

mkdir -p -- $dest/media || die "Can't create $dest"
cp -X -- $xml "$dest/$name.fcpxml" || die "Couldn't copy the XML."
# Title fonts the editor installed (their own copies, from Font Book): SharedCut needs them to set the titles.
typeset -U fontfiles; unmatched=()
for family in ${(f)"$(xmllint --xpath "//text-style/@font" $xml 2>/dev/null | grep -o 'font="[^"]*"' | sed 's/^font="//; s/"$//' | sort -u)"}; do
  key=${${(L)family}//[^a-z0-9]/} hit=0
  for f in ~/Library/Fonts/*.(#i)(ttf|otf|ttc)(N.) /Library/Fonts/*.(#i)(ttf|otf|ttc)(N.); do
    [[ ${${(L)${f:t:r}}//[^a-z0-9]/} == ${key}* ]] && { fontfiles+=($f); hit=1 }
  done
  (( hit )) || [[ $key == (helvetica|helveticaneue|arial) ]] || unmatched+=($family)
done
if (( ${#fontfiles} )); then mkdir -p -- $dest/fonts && cp -X -- $fontfiles $dest/fonts/ || die "Couldn't copy the title fonts."; fi
: >| $dest/sources.tsv
for i in {1..${#found}}; do print -r -- "$found[i]	media/$names[i]" >> $dest/sources.tsv; done
if (( ${#missing} )); then print -rl -- $missing >| $dest/missing.txt; else rm -f -- $dest/missing.txt; fi

done_bytes=0
for i in {1..${#found}}; do
  out=$dest/media/$names[i] label="[$i/${#found}] $names[i] ($(human $sizes[i]))"
  if [[ -f $out && $(stat -f %z -- $out) == $sizes[i] ]]; then print -- "$label — already copied"
  else
    print -n -- "$label… "
    cp -X -- $found[i] "$out.part" && mv -f -- "$out.part" $out || die "Copy failed: $found[i]. Run the command again to resume."
    print "done"
  fi
  (( done_bytes += sizes[i] ))
  print -- "   $(human $done_bytes) of $(human $total)"
done

print "\nDone: $dest"
(( ${#missing} )) && print "${#missing} offline files were skipped (listed in missing.txt)."
(( ${#fontfiles} )) && print "${#fontfiles} title font files copied."
(( ${#unmatched} )) && print "Fonts to add in SharedCut by hand (built into macOS or Final Cut): ${(j:, :)unmatched}"
print "Eject ${root:t}, then bring it to the SharedCut host to import."
