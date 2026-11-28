"""Render the exact tested userscript manager under synthetic offline conditions.

No production origin or network connection is permitted. Requires Chromium and
the Python playwright package. The caller supplies an exact-head installer.
"""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

STARTUP = re.compile(r'  if \(document\.readyState === "loading"\)\n    document\.addEventListener\(')
DEFAULT_FIXTURE = Path(__file__).with_name("fixture.js")
VIEWPORTS = [(1440,900),(1024,768),(390,844)]
TABS = ["Workspaces","Connectors","Activity","Recovery","Settings"]

def run(bundle: Path, fixture: Path, output: Path, chromium: str):
    source = bundle.read_text()
    matches = list(STARTUP.finditer(source))
    if not matches:
        raise ValueError("Cannot isolate the exact userscript startup boundary.")
    mounted = source[:matches[-1].start()] + "  window.__auditMountManager = mountManager;\n})();\n"
    output.mkdir(parents=True,exist_ok=True)
    metrics=[]
    outbound=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(executable_path=chromium,args=[
            "--no-sandbox","--disable-background-networking","--disable-dev-shm-usage"])
        try:
            for width,height in VIEWPORTS:
                for total in [30,50]:
                    page=browser.new_page(viewport={"width":width,"height":height})
                    page.route("**/*",lambda route:(outbound.append(route.request.url),route.abort()))
                    try:
                        page.set_content("<html lang='en'><h1>Synthetic editor</h1><textarea>Untouched</textarea></html>")
                        page.evaluate("window.__fixtureMode='v2'")
                        page.add_script_tag(content=mounted)
                        page.add_script_tag(path=fixture)
                        page.get_by_role("row").filter(has_text="Story generator").first.wait_for()
                        if total==50:
                            page.evaluate("""() => {
                              for(let i=30;i<50;i++){
                                const row=structuredClone(fixture.w[i-30]);
                                row.id='w-'+(i+1);
                                row.label=String(i+1).padStart(2,'0')+' · '+
                                  row.label.replace(/^[0-9]+ · /,'');
                                if(row.binding) row.binding.generatorId='generator-'+(i+1);
                                row.connectorId='c-'+(i%12+1);
                                fixture.w.push(row);
                              }
                            }""")
                            page.get_by_role("button",name="Refresh",exact=True).first.click()
                            page.wait_for_function("""() => document.querySelector('[data-perch-mcp-manager]')
                              .shadowRoot.querySelectorAll('tbody tr').length === 50""")
                        for tab in TABS:
                            if tab!="Workspaces":
                                page.get_by_role("tab",name=tab,exact=True).click()
                                page.wait_for_function("""t => {
                                  const root=document.querySelector('[data-perch-mcp-manager]').shadowRoot;
                                  return root.querySelector('[role=tab][aria-selected=true]')?.textContent===t
                                    && root.querySelector('.notice')?.textContent==='Updated.';
                                }""",arg=tab)
                            measured=page.evaluate("""() => {
                              const root=document.querySelector('[data-perch-mcp-manager]').shadowRoot;
                              const dialog=root.querySelector('dialog'),body=root.querySelector('.body');
                              const rect=body.getBoundingClientRect();
                              const rows=[...body.querySelectorAll('tbody tr')];
                              return {
                                dialogOverflow:dialog.scrollHeight>dialog.clientHeight,
                                bodyHorizontalOverflow:body.scrollWidth>body.clientWidth,
                                viewportHorizontalOverflow:document.documentElement.scrollWidth>innerWidth,
                                visibleCompleteRows:rows.filter(row=>{
                                  const box=row.getBoundingClientRect();
                                  return box.height>0 && box.top>=rect.top && box.bottom<=rect.bottom;
                                }).length,
                                renderedRows:rows.length,
                                tabNames:[...root.querySelectorAll('[role=tab]')].map(x=>x.innerText),
                                selected:root.querySelector('[role=tab][aria-selected=true]')?.innerText,
                                remoteRequests:fixture.requests.length
                              };
                            }""")
                            record={"viewport":str(width)+"x"+str(height),"workspaces":total,"tab":tab,**measured}
                            metrics.append(record)
                            page.screenshot(path=output/(f"{width}x{height}-{total}-{tab}.png"))
                            assert not (record["dialogOverflow"] or record["bodyHorizontalOverflow"]
                              or record["viewportHorizontalOverflow"]),record
                            assert record["tabNames"]==TABS,record
                            assert record["selected"]==tab,record
                            if tab=="Workspaces":
                                assert record["renderedRows"]==total,record
                                if width==1440:
                                    assert record["visibleCompleteRows"]>=8,record
                                if width==1024:
                                    assert record["visibleCompleteRows"]>=6,record
                                if width==390:
                                    assert record["visibleCompleteRows"]>=1,record
                    finally:
                        page.close()
        finally:
            browser.close()
    report={"commitArtifact":str(bundle.name),"metrics":metrics,"externalRequests":outbound}
    (output/"metrics.json").write_text(json.dumps(report,indent=2)+"\n")
    assert not outbound,outbound
    return report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--bundle",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--fixture",type=Path,default=DEFAULT_FIXTURE)
    parser.add_argument("--chromium",default="/usr/bin/chromium")
    args=parser.parse_args()
    report=run(args.bundle,args.fixture,args.output,args.chromium)
    print(json.dumps({"snapshots":len(report["metrics"]),"externalRequests":len(report["externalRequests"])}))

if __name__=="__main__":
    main()
