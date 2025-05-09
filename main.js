import * as cheerio from "cheerio";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

const BASE_URL = "https://www.ais.pansa.pl/publikacje/aip-polska/";
const TARGET_LINK_PREFIXES = {
  VFR: "https://ais.pansa.pl/eAIPVFR",
  IFR: "https://ais.pansa.pl/eAIPIFR",
};
const OUTPUT_BASE_DIR = "AIP";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
};

function sanitizeFilename(name) {
  if (!name || typeof name !== "string") {
    return "untitled";
  }
  let saneName = name.replace(/[<>:"/\\|?*]/g, "_");
  saneName = saneName.trim();
  saneName = saneName.replaceAll("  ", " ");
  return saneName || "untitled";
}

async function downloadFile(url, targetPath) {
  if(await Bun.file(targetPath).exists()) {
    console.log(`    Skipping ${url} because it already exists`);
    return true;
  }
  try {
    console.log(`    Downloading: ${url}`);
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(
        `Failed to download ${url}: ${response.status} ${response.statusText}`
      );
    }
    await Bun.write(targetPath, response);
    console.log(`    Saved to: ${targetPath}`);
    return true;
  } catch (error) {
    console.error(`    Error downloading ${url}: ${error.message}`);
    return false;
  }
}

async function processMenuItems(
  items,
  currentFsPath,
  pdfDocBaseUrl,
  langCode = "pl-PL"
) {
  for (const item of items) {
    const itemTitle = item.title || "Untitled_Folder";
    const sanitizedItemTitle = sanitizeFilename(itemTitle);
    const itemPath = join(currentFsPath, sanitizedItemTitle);

    try {
      await mkdir(currentFsPath, { recursive: true });
      console.log(`  Created directory: ${currentFsPath}`);
    } catch (error) {
      console.error(`  Error creating directory ${currentFsPath}: ${error.message}`);
      continue;
    }

    const href = item.href;
    if (href) {
      const pdfNameMatch = href.match(/^(.*?)(?:-[a-z]{2}-[A-Z]{2})?\.html/);
      if (pdfNameMatch && pdfNameMatch[1]) {
        const pdfBaseName = pdfNameMatch[1];
        const pdfUrl = new URL(
          `${encodeURIComponent(pdfBaseName)}.pdf`,
          pdfDocBaseUrl
        ).href;

        let hasDuplicateInSubtree = false;
        for(const child of item.children) {
          if(child.href && child.href == href) {
            hasDuplicateInSubtree = true;
            break;
          }
        }

        const pdfTargetPath = item.children.length > 0 ?  `${itemPath}/${sanitizedItemTitle}.pdf` : `${itemPath}.pdf`;

        if(!hasDuplicateInSubtree) {
          await downloadFile(pdfUrl, pdfTargetPath);
        }
      }
    }

    if (item.children && item.children.length > 0) {
      await processMenuItems(
        item.children,
        itemPath,
        pdfDocBaseUrl,
        langCode
      );
    }
  }
}

async function main() {
  try {
    await mkdir(OUTPUT_BASE_DIR, { recursive: true });
    console.log(`Output directory will be: ${OUTPUT_BASE_DIR}`);
  } catch (e) {
    console.warn(`Could not ensure output directory ${OUTPUT_BASE_DIR}: ${e.message}`);
  }


  let mainPageHtml;
  try {
    console.log(`Fetching main AIP page: ${BASE_URL}`);
    const response = await fetch(BASE_URL, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    mainPageHtml = await response.text();
  } catch (error) {
    console.error(`Error fetching main page ${BASE_URL}: ${error.message}`);
    return;
  }

  const $main = cheerio.load(mainPageHtml);
  const foundEaipLinks = {};

  for (const [typeKey, prefix] of Object.entries(TARGET_LINK_PREFIXES)) {
    const linkTag = $main(`a[href^="${prefix}"]`).first();
    if (linkTag.length) {
      const href = linkTag.attr("href");
      if (href) {
        foundEaipLinks[typeKey] = new URL(href, BASE_URL).href;
        console.log(
          `Found ${typeKey} eAIP entry page link: ${foundEaipLinks[typeKey]}`
        );
      }
    } else {
      console.log(`Could not find ${typeKey} eAIP link starting with ${prefix}`);
    }
  }

  if (Object.keys(foundEaipLinks).length === 0) {
    console.log("No eAIP links found. Exiting.");
    return;
  }

  for (const [typeKey, eaipEntryPageUrl] of Object.entries(foundEaipLinks)) {
    console.log(`\n--- Processing ${typeKey} from ${eaipEntryPageUrl} ---`);
    let eaipPageHtml;
    try {
      const response = await fetch(eaipEntryPageUrl, { headers: HEADERS });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      eaipPageHtml = await response.text();
    } catch (error) {
      console.error(
        `Error fetching ${typeKey} page ${eaipEntryPageUrl}: ${error.message}`
      );
      continue;
    }

    const $eaip = cheerio.load(eaipPageHtml);
    const firstHistoryTable = $eaip("table.HISTORY").first();
    if (!firstHistoryTable.length) {
      console.log(
        `Could not find the first 'HISTORY' table on ${eaipEntryPageUrl}`
      );
      continue;
    }

    let dataRow;
    firstHistoryTable.find("tr").each((i, tr) => {
      const $tr = $eaip(tr);
      if ($tr.find("td").length > 0) {
        if ($tr.find("td[style*='background-color']").length > 0) {
          dataRow = $tr;
          return false;
        }
        if (!dataRow) {
          dataRow = $tr;
        }
      }
    });
    
    if (!dataRow) {
        firstHistoryTable.find("tr").each((i, tr) => {
            const $tr = $eaip(tr);
            if ($tr.find("td a[href]").length > 0) {
                dataRow = $tr;
                return false;
            }
        });
    }


    if (!dataRow || !dataRow.length) {
      console.log(
        `Could not find the data row in the first 'HISTORY' table for ${typeKey}.`
      );
      continue;
    }

    const tds = dataRow.find("td");
    if (tds.length < 3) {
      console.log(`Data row for ${typeKey} does not have enough columns.`);
      continue;
    }

    let effectiveDate, relativeAmdtLink, publicationDate;
    try {
      const effectiveDateTag = tds.eq(0).find("a").first();
      if (!effectiveDateTag.length) {
        console.log(`Could not find effective date link for ${typeKey}.`);
        continue;
      }
      effectiveDate = effectiveDateTag.text().trim();
      relativeAmdtLink = effectiveDateTag.attr("href");
      publicationDate = tds.eq(1).text().trim();

      if (!relativeAmdtLink) {
        console.log(`Effective date link has no href for ${typeKey}.`);
        continue;
      }

      console.log(`\nFound ${typeKey} Amendment:`);
      console.log(`  Data wejścia w życie (Effective Date): ${effectiveDate}`);
      console.log(`  Data publikacji (Publication Date): ${publicationDate}`);
      console.log(`  Relative link part: ${relativeAmdtLink}`);
    } catch (e) {
      console.error(`Error parsing amendment details for ${typeKey}: ${e.message}`);
      console.error(`Problematic row HTML: ${dataRow.html()}`);
      continue;
    }

    const confirm = prompt(
      `Proceed with downloading ${typeKey} data for effective date ${effectiveDate}? (y/n): `
    );
    if (confirm?.toLowerCase() !== "y") {
      console.log(`Skipping ${typeKey} data.`);
      continue;
    }

    const normalizedRelativeLink = relativeAmdtLink.replace(/\\/g, "/");
    const pathParts = normalizedRelativeLink.split("/");
    if (pathParts.length === 0) {
      console.log(
        `Could not parse folder name from relative link: ${relativeAmdtLink}`
      );
      continue;
    }
    const amdtFolderName = pathParts[0];

    const dateMatch = amdtFolderName.match(/(\d{4})_(\d{2})_(\d{2})/);
    if (!dateMatch) {
      console.log(
        `Could not extract date from AMDT folder name: ${amdtFolderName}`
      );
      console.log(
        `Skipping ${typeKey} due to date extraction failure from folder name.`
      );
      continue;
    }
    const [, year, month, day] = dateMatch;
    const dateForUrlPath = `${year}-${month}-${day}`;

    const eaipTypeBaseUrl = TARGET_LINK_PREFIXES[typeKey];
    const encodedAmdtFolderName = encodeURIComponent(amdtFolderName);

    const amendmentContentBaseUrl = `${eaipTypeBaseUrl.replace(/\/$/, "")}/${dateForUrlPath}/${encodedAmdtFolderName}/`;
    const datasourceJsUrl = new URL("v2/js/datasource.js", amendmentContentBaseUrl).href;
    const pdfDocumentBaseUrl = new URL("documents/PDF/", amendmentContentBaseUrl).href; 

    console.log(`  Constructed datasource.js URL: ${datasourceJsUrl}`);
    console.log(`  Constructed PDF base URL: ${pdfDocumentBaseUrl}`);

    let jsContent;
    try {
      const response = await fetch(datasourceJsUrl, { headers: HEADERS });
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      jsContent = await response.text();
    } catch (error) {
      console.error(
        `Error fetching datasource.js for ${typeKey}: ${error.message}`
      );
      continue;
    }

    let datasource;
    try {
      const context = eval(jsContent + " DATASOURCE")

      if (typeof context === 'object') {
        datasource = context;
      } else {
        throw new Error("DATASOURCE object not found in script context.");
      }
    } catch (error) {
      console.error(
        `Error executing or processing datasource.js for ${typeKey}: ${error.message}`
      );
      continue;
    }

    console.log(`Successfully parsed datasource.js for ${typeKey}`);

    const currentOutputDirName = `${typeKey}_${dateForUrlPath}`;
    const currentOutputPath = join(OUTPUT_BASE_DIR, currentOutputDirName);
    await mkdir(currentOutputPath, { recursive: true });
    console.log(`Root directory for this download: ${currentOutputPath}`);

    const selectedLangCode = "pl-PL";
    if (datasource.tabs && datasource.tabs.length > 0) {
      const aipTab = datasource.tabs[0];
      if (
        aipTab.contents &&
        aipTab.contents[selectedLangCode] &&
        aipTab.contents[selectedLangCode].menu
      ) {
        const langContent = aipTab.contents[selectedLangCode];
        console.log(
          `Processing menu for ${typeKey} (${selectedLangCode})...`
        );
        await processMenuItems(
          langContent.menu,
          currentOutputPath,
          pdfDocumentBaseUrl,
          selectedLangCode
        );
      } else {
        console.log(
          `'menu' or content for language '${selectedLangCode}' not found in the first tab for ${typeKey}.`
        );
      }
    } else {
      console.log(`'tabs' not found or empty in datasource for ${typeKey}.`);
    }
    console.log(`--- Finished processing ${typeKey} ---`);
  }
  console.log("\nScript finished.");
}

main().catch((error) => {
  console.error("Unhandled error in main execution:", error);
  process.exit(1);
});
