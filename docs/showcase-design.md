# Project replay

The first screen is a simplified SharedCut editor replaying the real Girls Soccer history. Visitors can watch, pause, scrub, jump between edit sessions, and inspect a contributor without signing in. Existing editor routes retain their behavior.

The product reference is SharedCut's current dark shell: its brand, teal video clips, muted purple audio, compact toolbars, and fine panel dividers. The distinct detail is named colored cursors attached to the actual edits. Motion between recorded targets is illustrative, disclosed in the replay information.

Hierarchy: project and playback controls; large source preview with the current edit; timeline construction; the five contributors and historical time. Desktop target 1440x900, mobile 390x844. On small screens keep the viewer and timeline; collapse the media bin and secondary details. No hover-only primary actions.

The replay is a separately compiled public package, not a public connection to the live workspace. Only explicit author display names, public thumbnails/previews, and visual timeline state leave the private history. No account emails, credentials, source paths, comments, or raw snapshots. The original history remains private and intact.

Loading: stable editor skeleton. Empty: explain no replay has been published. Error: retry loading. Partial: retain the timeline if an image/video is missing. Success: functional replay and contributor inspection. Permission: no account needed to view the curated package; editor sign-in remains separate.

Reduced motion starts paused and disables animated transforms. Keyboard-accessible buttons and a labeled range control provide pause, restart, scrubbing, speed, and chapters. Automatic playback pauses in a hidden tab. No sound autoplay.
