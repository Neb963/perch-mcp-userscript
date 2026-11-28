"""Offline exact-bundle F18/F19/F22/UI-legacy regression gates. No provider requests."""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

MARK = re.compile(r'  if \(document\.readyState === "loading"\)\n    document\.addEventListener\(')
ROOT = Path(__file__).resolve().parent

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--bundle',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    text=args.bundle.read_text()
    cuts=list(MARK.finditer(text))
    assert cuts,'Unknown bundle startup boundary'
    mounted=text[:cuts[-1].start()]+'  window.__auditMountManager = mountManager;\n})();\n'
    args.output.mkdir(parents=True,exist_ok=True)
    outbound=[]
    def start(browser,mode='v2',hold_remote=False):
        page=browser.new_page(viewport={'width':1440,'height':900})
        page.route('**/*',lambda route:(outbound.append(route.request.url),route.abort()))
        page.set_content('<html><h1>Synthetic editor</h1><textarea>Untouched</textarea></html>')
        # about:blank is not a secure origin; emulate only the standard Web Crypto
        # UUID function available on production HTTPS, using actual crypto entropy.
        page.evaluate('''() => {
          if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', {value: () => {
            const x=crypto.getRandomValues(new Uint8Array(16));
            x[6] = (x[6] & 15) | 64;
            x[8] = (x[8] & 63) | 128;
            const v=Array.from(x, b=>b.toString(16).padStart(2,'0')).join('');
            return v.slice(0,8)+'-'+v.slice(8,12)+'-'+v.slice(12,16)+'-'+v.slice(16,20)+'-'+v.slice(20);
          }});
        }''')
        page.evaluate('mode => window.__fixtureMode=mode',mode)
        page.add_script_tag(content=mounted)
        fixture_text=(ROOT/'fixture.js').read_text()
        if hold_remote:
            assert 'void fixture.mount();' in fixture_text
            fixture_text=fixture_text.replace('void fixture.mount();', 'fixture.delay=60000; void fixture.mount();')
        page.add_script_tag(content=fixture_text)
        page.get_by_role('dialog').wait_for()
        return page
    evidence={}
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-background-networking','--disable-dev-shm-usage'])
        try:
            page=start(browser)
            page.get_by_role('row').filter(has_text='Story generator').first.wait_for()
            read_before=page.evaluate('fixture.requests.length')
            search=page.get_by_role('searchbox',name='Filter')
            search.fill('Story generator')
            page.wait_for_function('''() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.querySelectorAll('tbody tr').length === 3''')
            search.fill('Usage analytics')
            page.wait_for_function('''() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.querySelectorAll('tbody tr').length === 3''')
            search.fill('')
            page.wait_for_function('''() => document.querySelector('[data-perch-mcp-manager]').shadowRoot.querySelectorAll('tbody tr').length === 30''')
            read_after=page.evaluate('fixture.requests.length')
            assert read_after==read_before,(read_before,read_after)
            evidence['F22_localFilter']={'requestsBefore':read_before,'requestsAfter':read_after}
            page.screenshot(path=args.output/'F22-local-filter.png')
            page.close()

            page=start(browser)
            row=page.get_by_role('row').filter(has_text='Image studio').first
            disclosure=row.locator('summary',has_text='More actions')
            disclosure.wait_for()
            before=page.evaluate('fixture.requests.length')
            disclosure.click()
            details=row.locator('details.secondary-actions').inner_text()
            assert 'SourceRevision: UNKNOWN (no verified native readback)' in details,details[:500]
            assert 'PreviewRevision: UNKNOWN (no verified native readback)' in details
            assert 'SavedRevision: UNKNOWN (no verified native readback)' in details
            assert 'Last result: UNKNOWN (' in details
            assert 'In-flight/Hold: UNKNOWN (' in details
            assert page.evaluate('fixture.requests.length')==before,'Detail expansion must remain local.'
            page.get_by_role('tab',name='Activity',exact=True).click()
            page.get_by_role('tab',name='Workspaces',exact=True).click()
            row=page.get_by_role('row').filter(has_text='Image studio').first
            row.locator('summary',has_text='More actions').click()
            details=row.locator('details.secondary-actions').inner_text()
            assert 'Last result (observed ' in details and 'UNKNOWN · batch' in details,details[:1000]
            assert 'In-flight/Hold: UNKNOWN — inspect Recovery' in details
            evidence['S10_004_revisionAndResult']={'verifiedRevisionNotFabricated':True,
                'lastObservedWorkspaceOperationShown':True,'explicitHoldUncertainty':True,
                'extraRequestsOnExpansion':0}
            page.screenshot(path=args.output/'S10-004-revision-provenance.png')
            page.close()

            page=start(browser)
            page.get_by_role('tab',name='Connectors',exact=True).click()
            page.get_by_role('button',name='Approve exact request',exact=True).wait_for()
            search=page.get_by_role('searchbox',name='Filter')
            read_before=page.evaluate('fixture.requests.length')
            search.fill('ChatGPT 12')
            assert page.get_by_role('button',name='Approve exact request',exact=True).count()==1
            assert page.get_by_role('button',name='Approve exact request',exact=True).is_enabled()
            read_after=page.evaluate('fixture.requests.length')
            assert read_after==read_before,(read_before,read_after)
            evidence['F18_urgentApprovalIndependent']={'filter':'ChatGPT 12','approvalOwner':'c-1',
                'approvalStillActionable':True,'additionalRequests':read_after-read_before}
            page.screenshot(path=args.output/'F18-filtered-approval.png')
            page.close()

            page=start(browser)
            row=page.get_by_role('row').filter(has_text='Image studio').first
            row.get_by_role('button',name='Reassign to this tab',exact=True).wait_for()
            page.evaluate('fixture.delay = 1000')
            row.get_by_role('button',name='Reassign to this tab',exact=True).click()
            # Clean idle reassign is one click; no confirmation dialogue is expected.
            page.wait_for_function("fixture.requests.some(x=>x.method!=='GET')")
            state=row.evaluate('''r => [...r.querySelectorAll('button')].filter(x =>
              /^(Reconnect|Detach|Pause|Transfer|Unassign|Reassign to this tab)$/.test(x.textContent.trim()))
              .map(x=>({action:x.textContent.trim(),disabled:x.disabled}))''')
            assert state,state
            assert all(x['disabled'] for x in state),state
            evidence['F19_conflictingControls']={'state':state,'pending':True}
            page.screenshot(path=args.output/'F19-pending-row.png')
            page.close()

            page=start(browser,hold_remote=True)
            assert page.get_by_role('tab',name='Workspaces',exact=True).count()==1
            page.get_by_role('tab',name='Recovery',exact=True).click()
            recovery=page.get_by_role('dialog').inner_text()
            assert 'Recovery' in recovery and ('local' in recovery.lower() or 'checkpoint' in recovery.lower()), recovery[:700]
            page.get_by_role('tab',name='Settings',exact=True).click()
            settings=page.get_by_role('dialog').inner_text()
            assert 'Settings' in settings and ('Gateway' in settings or 'Diagnostics' in settings), settings[:700]
            assert not page.get_by_role('button',name='Reassign to this tab',exact=True).count()
            evidence['F26_pendingRemoteLocalShell']={
                'recoveryAvailable':True,'settingsAvailable':True,
                'remoteRequestPending':True,'externalRequests':len(outbound)}
            page.screenshot(path=args.output/'F26-pending-remote-settings.png')
            page.close()

            for mode in ('v1','v2','outage','unpaired'):
                page=start(browser,mode)
                tabs=[x.strip() for x in page.get_by_role('tab').all_inner_texts()]
                assert tabs==['Workspaces','Connectors','Activity','Recovery','Settings'],(mode,tabs)
                assert 'Library' not in tabs
                evidence['F25_noLibrary_'+mode]=tabs
                page.close()
        finally:
            browser.close()
    assert not outbound,outbound
    evidence['externalRequests']=len(outbound)
    (args.output/'closure-results.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence))

if __name__=='__main__':main()
