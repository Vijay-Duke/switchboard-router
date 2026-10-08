# IBM Plex fonts

Original, unmodified complete WOFF2 files from IBM Plex. These retain the
dashboard's IBM Plex Sans (400/500/600/700) and IBM Plex Mono (400/500/600)
families and styles, including Latin, Cyrillic and Greek coverage.

The pinned upstream URLs and SHA-256 hashes are in sources.json. The original
copyright and SIL Open Font License 1.1 are included in
public/fonts/IBM-Plex-LICENSE.txt, which is also copied into the CLI release.

Next.js loads these files with next/font/local. Production builds and CLI packs
therefore do not depend on Google Fonts availability or returned URL shapes.
