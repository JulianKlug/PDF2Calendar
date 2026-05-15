// Renders one PNG per person — composed of the header strip stacked above the
// person's row, cropped from the same scale-2.0 (144 DPI) page render.
//
// See docs/frontend-spec.md § Algorithm Step 2. The legacy ESM build is used
// in both the parser and here, so pdfjs is loaded once per page load even
// though two files import it (spec § Step 0).

import { ParseError, type YBand } from "../src/types.ts";

const SCALE = 2.0; // 144 DPI = 2× default 72 DPI
const MARGIN_PT = 5; // PDF points of padding above the header / below the row
const GUTTER_PX = 4; // canvas pixels between header and row in the multi-page composite

export type RowJob = {
  person_hash: string;
  row_band: YBand;
};

type PageRender = {
  canvas: HTMLCanvasElement;
  heightPt: number;
};

export async function renderRowImages(
  bytes: Uint8Array,
  header_band: YBand,
  jobs: RowJob[],
  onProgress: (done: number, total: number) => void | Promise<void>,
): Promise<Map<string, Blob>> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  const result = new Map<string, Blob>();
  const pages = new Map<number, PageRender>();

  try {
    const neededPages = new Set<number>([header_band.page]);
    for (const job of jobs) neededPages.add(job.row_band.page);

    for (const pageNum of neededPages) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new ParseError("internal_validation_failed", {
          check: "canvas_2d_context_unavailable",
        });
      }
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.set(pageNum, { canvas, heightPt: viewport.height / SCALE });
    }

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      // Always composite header strip + person row with a gutter. The spec
      // describes a "one crop" same-page path from header_band.y_top to
      // row_band.y_bottom, but that would include every colleague's row
      // sitting between the header and the target row — a ~1.7 MP image
      // per person on a 45-row page, both a file-size bomb and a privacy
      // leak. The multi-page composition (header + 4 px gutter + row) is
      // what the user actually needs to see.
      const outCanvas = composeRow(pages, header_band, job.row_band);

      const blob = await new Promise<Blob | null>((res) =>
        outCanvas.toBlob(res, "image/png"),
      );
      if (!blob) {
        throw new ParseError("internal_validation_failed", {
          check: "canvas_toBlob_returned_null",
        });
      }
      result.set(job.person_hash, blob);
      await onProgress(i + 1, jobs.length);
    }
  } finally {
    await doc.cleanup();
  }

  return result;
}

type Crop = {
  source: HTMLCanvasElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

function cropBand(
  pages: Map<number, PageRender>,
  pageNum: number,
  y_top_pt: number,
  y_bottom_pt: number,
): Crop {
  const page = pages.get(pageNum);
  if (!page) {
    throw new ParseError("internal_validation_failed", {
      check: "row_image_missing_page",
      reason: `page ${pageNum}`,
    });
  }
  // PDF origin is bottom-left; canvas origin is top-left.
  // canvas_y = (page_height_pt - y_pdf) * SCALE.
  // The higher PDF y (y_top) gives the smaller canvas y (top of crop).
  const sy = Math.max(0, Math.floor((page.heightPt - y_top_pt) * SCALE));
  const syEnd = Math.min(
    page.canvas.height,
    Math.ceil((page.heightPt - y_bottom_pt) * SCALE),
  );
  return {
    source: page.canvas,
    sx: 0,
    sy,
    sw: page.canvas.width,
    sh: Math.max(1, syEnd - sy),
  };
}

function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ParseError("internal_validation_failed", {
      check: "canvas_2d_context_unavailable",
    });
  }
  return { canvas, ctx };
}

function composeRow(
  pages: Map<number, PageRender>,
  header_band: YBand,
  row_band: YBand,
): HTMLCanvasElement {
  const headerCrop = cropBand(
    pages,
    header_band.page,
    header_band.y_top + MARGIN_PT,
    header_band.y_bottom,
  );
  const rowCrop = cropBand(
    pages,
    row_band.page,
    row_band.y_top,
    row_band.y_bottom - MARGIN_PT,
  );
  const width = Math.max(headerCrop.sw, rowCrop.sw);
  const height = headerCrop.sh + GUTTER_PX + rowCrop.sh;
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(
    headerCrop.source,
    headerCrop.sx,
    headerCrop.sy,
    headerCrop.sw,
    headerCrop.sh,
    0,
    0,
    headerCrop.sw,
    headerCrop.sh,
  );
  ctx.drawImage(
    rowCrop.source,
    rowCrop.sx,
    rowCrop.sy,
    rowCrop.sw,
    rowCrop.sh,
    0,
    headerCrop.sh + GUTTER_PX,
    rowCrop.sw,
    rowCrop.sh,
  );
  return canvas;
}
