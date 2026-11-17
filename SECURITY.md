# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.1.x` (current `main` / `v0.1.0`) | Yes |

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities in public GitHub issues before they have been investigated and patched.

Instead, report vulnerabilities through one of these private channels:

- **GitHub Private Vulnerability Reporting:** Open a draft advisory at `https://github.com/tholtman1-del/deadboard/security/advisories/new`
- **Email:** Send details to **t.holtman1@gmail.com** with `[DEADBOARD Security]` in the subject line

When reporting, please include:
1. A clear description of the issue and potential impact.
2. Step-by-step reproduction instructions (and a minimal sample `.kicad_pcb`, `.brd`, `.pcbfix.json`, or mod `.zip` file if applicable).
3. Affected browser/OS or Node.js version.

You can expect an acknowledgment within **72 hours** and regular status updates until a fix is released.

## Security Architecture & Scope

DEADBOARD runs entirely client-side in the browser (static site built with Vite + TypeScript + WebGPU, with no backend user accounts or server-side database). Its primary attack surface is **parsing and rendering untrusted user-supplied hardware files and community mods**:

- **Board & Challenge Importers:** `.kicad_pcb`, `.brd` (OpenBoardView/TopTest), `.pcbfix.json`, and BOM CSV/TSV files (`src/io/`).
- **Data-Only Community Mods (`deadboard-mod/1`):** Mods never contain executable code (`src/mods/mods.ts`). Only validated manifests (`mod.json`), supported board files, BOM tables, and schematic media (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`) are accepted.
- **ZIP Archive Defenses (`src/mods/zip.ts`):**
  - Rejects encrypted entries, ZIP64 archives, and path traversal (`cleanPath()` blocks `..`, null bytes, and drive-letter prefixes).
  - Enforces `ZIP_LIMITS` against zip bombs (`4,000` entries max, `256 MiB` unpacked per file, `512 MiB` total unpacked) and cancels decompression immediately if a stream exceeds its declared header size.
- **Challenge Flag Encryption:** Authored challenges lock completion flags against the working reference circuit topology; note that challenge flags are designed as puzzle verification, not cryptographic protection of sensitive secrets.
- **Feedback Form:** The optional bench feedback modal submits user-entered messages (and optional technical diagnostics when opted in) through FormSubmit when `VITE_FEEDBACK_TO` is configured, or falls back to a prefilled GitHub issue.

### High-Priority Report Categories
- Cross-site scripting (XSS) or HTML/SVG/PDF injection via mod manifests, board metadata, part labels, or schematic previews.
- Zip-bomb, parser-hang, or unbounded memory allocation bugs when importing malformed `.zip`, `.kicad_pcb`, `.brd`, `.csv`, or `.json` files.
- Vulnerabilities in build/deploy workflows or third-party dependencies.
