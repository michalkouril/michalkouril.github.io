# michalkouril.github.io

Source for [www.michalkouril.com](https://www.michalkouril.com/), served by GitHub Pages
from `master`.

| Path | What it is |
| --- | --- |
| `index.html` | The site: about, coordinating centers, research, software, publications, teaching and service, contact. |
| `og-card.png` | Social preview image (1200×630), referenced by `og:image`. Regenerate from `og-card.source.html`. |
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

It exits 1 only for genuinely broken links (the hook and CI below treat
that as a warning, never a blocker). Publishers and LinkedIn refuse
automated requests and return 403 — those are reported separately and don't fail the
run, because failing on them would make the check noise. Server errors get one retry,
and if nothing resolves at all it assumes you're offline, skips, and exits 2.

**On commit** — install the hook once:

```sh
ln -sf ../../tools/pre-commit .git/hooks/pre-commit
```

It runs when HTML is staged and warns about dead links, but lets the commit through.

**On push and weekly** — `.github/workflows/check-links.yml` runs it in CI, so link rot
surfaces even when nothing changes. The check is soft: the run stays green and the site
deploys regardless. Dead links show as a warning on the run, and on `master` the workflow
opens a **Broken links on michalkouril.com** issue assigned to you, refreshes it on every
run and comments on it each week while links stay broken. The issue closes itself once
every link is alive again. The run only goes red if the checker itself crashes.
