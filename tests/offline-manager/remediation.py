"""Exercise the bundled manager against synthetic data, with all network denied."""
import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

FIXTURE = Path(__file__).with_name("fixture.js")
STARTUP = re.compile(r'  if \(document\.readyState === "loading"\)\n    document\.addEventListener\(')
CONTEXT = """<!doctype html><html lang="en"><title>Offline native editor</title>
<main><h1>Synthetic native editor</h1><textarea>Untouched draft</textarea></main>"""


def run(browser, bundle, output):
    report = {}
    external = []

    def mount(mode):
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.route("**/*", lambda route: (external.append(route.request.url), route.abort()))
        page.set_content(CONTEXT)
        page.evaluate("""mode => {
          window.__fixtureMode = mode;
          if (!crypto.randomUUID) crypto.randomUUID = () =>
            '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,
              c => (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16));
        }""", mode)
        page.add_script_tag(content=bundle)
        page.add_script_tag(path=FIXTURE)
        page.get_by_role("dialog").wait_for()
        if mode not in ("outage", "unpaired"):
            page.get_by_role("row").filter(has_text="Story generator").first.wait_for()
        return page

    def snapshot(page, name):
        value = page.evaluate("""() => {
          const root = document.querySelector('[data-perch-mcp-manager]').shadowRoot;
          const panel = root.querySelector('.body');
          return {
            selected: root.querySelector('[role=tab][aria-selected=true]')?.innerText,
            tabNames: [...root.querySelectorAll('[role=tab]:not([hidden])')].map(x => x.innerText),
            panel: panel.innerText.slice(0, 600),
            enabled: [...panel.querySelectorAll('button:not(:disabled)')].slice(0, 20).map(x => x.innerText),
            requests: fixture.requests.map(x => ({method:x.method, path:x.path})),
          };
        }""")
        report[name] = value
        page.screenshot(path=output / (name + ".png"))

    for mode in ("v1", "v2", "outage", "unpaired"):
        page = mount(mode)
        snapshot(page, mode)
        page.close()

    page = mount("v2")
    page.evaluate("fixture.mode='outage'")
    page.get_by_role("tab", name="Connectors", exact=True).click()
    snapshot(page, "warm-outage-connectors")
    page.get_by_role("tab", name="Recovery", exact=True).click()
    snapshot(page, "warm-outage-recovery")
    page.close()

    page = mount("v2")
    for name in ("Story generator", "Usage analytics"):
        row = page.get_by_role("row").filter(has_text=name).first
        action = row.get_by_role("button", name="Reassign to this tab", exact=True)
        if action.is_enabled():
            action.click()
    confirmations = page.get_by_role("button", name="Confirm", exact=True)
    report["confirmationCount"] = confirmations.count()
    page.screenshot(path=output / "confirmation.png")
    if confirmations.count():
        confirmations.first.click()
        page.wait_for_function("fixture.requests.some(x => x.method !== 'GET')", timeout=2000)
    report["confirmationWrites"] = page.evaluate(
        "fixture.requests.filter(x => x.method !== 'GET').map(x => ({method:x.method, path:x.path}))")
    page.close()

    page = mount("v2")
    page.get_by_role("tab", name="Connectors", exact=True).click()
    approval = page.get_by_role("row").filter(has_text="fixture-client-new")
    approval.wait_for()
    report["approvalText"] = approval.inner_text()
    page.screenshot(path=output / "approval.png")
    page.close()

    assert external == [], external
    report["externalRequests"] = len(external)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, default=Path("dist/perch-mcp.user.js"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--expect-baseline", action="store_true")
    args = parser.parse_args()
    source = args.bundle.read_text()
    matches = list(STARTUP.finditer(source))
    assert matches, "Cannot isolate bundled startup"
    mounted = source[:matches[-1].start()] + "  window.__auditMountManager = mountManager;\n})();\n"
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, args=[
            "--no-sandbox", "--disable-background-networking", "--disable-dev-shm-usage",
        ])
        report = run(browser, mounted, args.output)
        browser.close()
    (args.output / "manager-report.json").write_text(json.dumps(report, indent=2) + "\n")
    stale_views = [report[name] for name in ("warm-outage-connectors", "warm-outage-recovery")]
    results = {
        "F17": report["confirmationCount"] > 1
        or any("/w-2/" not in row["path"] for row in report["confirmationWrites"]),
        "F21": any(field not in report["approvalText"]
                   for field in ("ChatGPT 01", "https://fixture.invalid/mcp/c-1", "READ_SOURCE")),
        "F25": any("Library" in report[mode]["tabNames"] for mode in ("v1", "v2", "outage", "unpaired")),
        "F26": "Gateway unavailable" in report["outage"]["panel"] and "Story generator" not in report["outage"]["panel"],
        "F27": any("Reassign to this tab" in view["enabled"] for view in stale_views),
    }
    print(json.dumps({"reproduced": results, "externalRequests": report["externalRequests"]}))
    assert all(reproduced is args.expect_baseline for reproduced in results.values()), results


if __name__ == "__main__":
    main()
