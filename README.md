# michalkouril.github.io

Source for [www.michalkouril.com](https://www.michalkouril.com/), served by GitHub Pages
from `master`.

| Path | What it is |
| --- | --- |
| `index.html` | The live homepage. |
| `index_new.html` | New personal site, under review. Carries a `noindex` tag — **delete that line when promoting it to `index.html`.** |
| `bloomsky1/`, `bloomsky2/` | Wi-Fi configurators for BloomSky SKY1 and SKY2 weather stations. |
| `tumblr-infinite-scrolling/` | Hosted copy of a script older Tumblr themes still reference. |
| `assets/` | Shared stylesheet for the utility subpages. |

## Checking links

The site links out to journals, funders and research platforms, so links rot. Two
checks run the same script:

```sh
python3 tools/check-links.py              # everything
python3 tools/check-links.py index.html   # one file
```

It exits non-zero only for genuinely broken links. Publishers and LinkedIn refuse
automated requests and return 403 — those are reported separately and don't fail the
run, because failing on them would make the check noise. Server errors get one retry,
and if nothing resolves at all it assumes you're offline and skips.

**On commit** — install the hook once:

```sh
ln -sf ../../tools/pre-commit .git/hooks/pre-commit
```

It runs when HTML is staged, and blocks the commit if a link is dead. Bypass with
`git commit --no-verify`.

**On push and weekly** — `.github/workflows/check-links.yml` runs it in CI, so link rot
surfaces in the Actions tab even when nothing changes.
