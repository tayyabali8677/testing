const { chromium } = require('playwright');
(async () => {
  const [,, html, pdf, footer] = process.argv;
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + html, { waitUntil: 'load' });
  await p.pdf({ path: pdf, format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#888;">${footer} &nbsp;|&nbsp; page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' } });
  await b.close();
})();
