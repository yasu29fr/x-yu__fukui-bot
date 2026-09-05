/**
 * ネタ帳の中継役（Google Apps Script）— X 版
 *
 * ふだんのネタに加えて、紹介する商品（アフィリエイト）も受け取る。
 *
 * Web アプリとして公開し、画面からの POST を受けて Google ドキュメントに追記する。
 * 静的ページから Google ドキュメントへ直接書き込むことはできないため、ここを挟む。
 *
 * 使い方は README の「ネタの記録」を参照。
 */

// ---- ここだけ書き換える -------------------------------------------------

/** 追記先のドキュメント ID（URL の /d/ と /edit のあいだ） */
const DOC_ID = "1k28LbhkYI5rUkEaJ1eU9j_kfuXsZavZy-9xNJTFO9D4";

/** 合言葉。画面の設定に入れるものと同じ文字列にする */
const SECRET = "ここに好きな合言葉を書く";

// ------------------------------------------------------------------------

/** ふだんのネタ: この見出しの直前に差し込む。見つからなければ後ろの候補を順に試す。 */
const INSERT_BEFORE = "書き方のヒント";
const INSERT_AFTER = "書き足す場所";

/**
 * 紹介する商品: この見出しの下に差し込む。
 *
 * compose.py はこの見出しの中を読み、`- 商品名 | URL | メモ` の行だけを拾う。
 * 見出しの文字列を変えるときは、compose.py の PRODUCT_SECTION も直すこと。
 */
const PRODUCT_HEADING = "紹介する商品";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return reply({ ok: false, error: "合言葉が違います" });

    if (data.kind === "product") {
      const name = String(data.name || "").trim();
      const url = String(data.url || "").trim();
      const memo = String(data.memo || "").trim();
      if (!name || !url) return reply({ ok: false, error: "商品名とURLは必須です" });
      // 「|」は区切り記号。混ざると行が壊れて読み取れなくなる。
      if ([name, url, memo].some(function (v) { return v.indexOf("|") >= 0; })) {
        return reply({ ok: false, error: "「|」は使えません" });
      }
      appendProduct(name, url, memo);
      return reply({ ok: true });
    }

    const text = String(data.text || "").trim();
    if (!text) return reply({ ok: false, error: "本文が空です" });

    appendNote(text, String(data.at || ""));
    return reply({ ok: true });
  } catch (error) {
    return reply({ ok: false, error: String(error) });
  }
}

/** 画面から読み返すため。合言葉が合ったときだけ本文を返す。 */
function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) {
    return reply({ ok: false, error: "合言葉が違います" });
  }
  return reply({ ok: true, text: DocumentApp.openById(DOC_ID).getBody().getText() });
}

function appendNote(text, at) {
  const body = DocumentApp.openById(DOC_ID).getBody();
  const index = insertionIndex(body);

  // 日時 → 本文 → 空行の順に差し込む。後ろから入れると並びが保たれる。
  body.insertParagraph(index, "");
  const paragraph = body.insertParagraph(index, text);
  paragraph.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  const stamp = body.insertParagraph(index, at);
  stamp.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  stamp.editAsText().setForegroundColor("#666666").setFontSize(9);
}

/**
 * 紹介する商品を「## 紹介する商品」の見出しの直下に足す。
 *
 * 1 行 1 件、`- 商品名 | URL | メモ` の形。この形以外の行は compose.py が読み飛ばす。
 * 見出しが無ければ、末尾に作ってから足す。
 */
function appendProduct(name, url, memo) {
  const body = DocumentApp.openById(DOC_ID).getBody();
  let index = -1;
  const count = body.getNumChildren();
  for (let i = 0; i < count; i += 1) {
    if (paragraphStartsWith(body.getChild(i), PRODUCT_HEADING)) {
      index = i;
      break;
    }
    // 「## 紹介する商品」のように記号付きで書かれている場合も拾う
    const child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      if (child.asParagraph().getText().indexOf(PRODUCT_HEADING) >= 0) {
        index = i;
        break;
      }
    }
  }

  if (index < 0) {
    body.appendParagraph("");
    body.appendParagraph("## " + PRODUCT_HEADING);
    index = body.getNumChildren() - 1;
  }

  const line = "- " + name + " | " + url + (memo ? " | " + memo : "");
  const paragraph = body.insertParagraph(index + 1, line);
  paragraph.setHeading(DocumentApp.ParagraphHeading.NORMAL);
}

/**
 * 差し込む位置を決める。
 *
 * ドキュメントの末尾に足すと「使ってほしくないネタ」の下に入ってしまうため、
 * 「書き方のヒント」の直前を第一候補にする。
 */
function insertionIndex(body) {
  const count = body.getNumChildren();
  for (let i = 0; i < count; i += 1) {
    if (paragraphStartsWith(body.getChild(i), INSERT_BEFORE)) return i;
  }
  for (let i = 0; i < count; i += 1) {
    if (paragraphStartsWith(body.getChild(i), INSERT_AFTER)) return i + 1;
  }
  return count;
}

function paragraphStartsWith(child, needle) {
  if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
  return child.asParagraph().getText().trim().indexOf(needle) === 0;
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
