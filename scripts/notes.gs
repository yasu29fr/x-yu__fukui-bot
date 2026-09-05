/**
 * ネタ帳の中継役（Google Apps Script）— 複数アカウント対応版
 *
 * Web アプリとして公開し、予約画面からの POST を受けて Google ドキュメントに追記する。
 * 静的ページから Google ドキュメントへ直接書き込むことはできないため、ここを挟む。
 *
 * **この 1 つで、Threads と X の両方のネタ帳をまかなう。**
 * Apps Script のプロジェクトを増やすと、そのたびに OAuth の承認をやり直すことになり、
 * 新しいプロジェクトでは「The OAuth client is not fully created yet」で止まることがある。
 * 承認済みのプロジェクトを使い回すほうが確実なので、宛先を切り替える作りにしてある。
 *
 * 受け取るもの:
 *   { secret, target, text, at }                  ふだんのネタ
 *   { secret, target, kind:"product", name, url, memo }   紹介する商品（X のみ）
 *
 * target を送ってこない古い画面は、DEFAULT_TARGET 宛てとして扱う。
 */

// ---- ここだけ書き換える -------------------------------------------------

/** 追記先のドキュメント ID（URL の /d/ と /edit のあいだ） */
const TARGETS = {
  threads: "1pIFgjku1znj5LVJcvdO9ZA0qlq6dRnc8jv5WVYzSHVY", // @yu._.fukui のネタ帳
  x: "1k28LbhkYI5rUkEaJ1eU9j_kfuXsZavZy-9xNJTFO9D4", // @yu__fukui のネタ帳
};

/** target が指定されなかったときの宛先。古い画面との互換のため */
const DEFAULT_TARGET = "threads";

/** 合言葉。画面の設定に入れるものと同じ文字列にする */
const SECRET = "ここに好きな合言葉を書く";

// ------------------------------------------------------------------------

/** ふだんのネタ: この見出しの直前に差し込む。無ければ後ろの候補を試す。 */
const INSERT_BEFORE = "書き方のヒント";
const INSERT_AFTER = "書き足す場所";

/**
 * 紹介する商品: この見出しの直下に差し込む。
 *
 * compose.py はこの見出しの中を読み、`- 商品名 | URL | メモ` の行だけを拾う。
 * 見出しの文字列を変えるときは、compose.py の PRODUCT_SECTION も直すこと。
 */
const PRODUCT_HEADING = "紹介する商品";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return reply({ ok: false, error: "合言葉が違います" });

    const docId = resolveTarget(data.target);
    if (!docId) return reply({ ok: false, error: "宛先が不明です: " + String(data.target) });

    if (data.kind === "product") {
      const name = String(data.name || "").trim();
      const url = String(data.url || "").trim();
      const memo = String(data.memo || "").trim();
      if (!name || !url) return reply({ ok: false, error: "商品名とURLは必須です" });
      // 「|」は区切り記号。混ざると行が壊れて読み取れなくなる。
      if ([name, url, memo].some(function (v) { return v.indexOf("|") >= 0; })) {
        return reply({ ok: false, error: "「|」は使えません" });
      }
      appendProduct(docId, name, url, memo);
      return reply({ ok: true });
    }

    const text = String(data.text || "").trim();
    if (!text) return reply({ ok: false, error: "本文が空です" });

    appendNote(docId, text, String(data.at || ""));
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
  const docId = resolveTarget(e.parameter.target);
  if (!docId) return reply({ ok: false, error: "宛先が不明です" });
  return reply({ ok: true, text: DocumentApp.openById(docId).getBody().getText() });
}

/** target 名からドキュメント ID を引く。知らない名前なら空を返す。 */
function resolveTarget(name) {
  const key = String(name || DEFAULT_TARGET);
  return Object.prototype.hasOwnProperty.call(TARGETS, key) ? TARGETS[key] : "";
}

function appendNote(docId, text, at) {
  const body = DocumentApp.openById(docId).getBody();
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
 * 紹介する商品を「紹介する商品」の見出しの直下に足す。
 *
 * 1 行 1 件、`- 商品名 | URL | メモ` の形。この形以外の行は compose.py が読み飛ばす。
 * 見出しが無ければ、末尾に作ってから足す。
 */
function appendProduct(docId, name, url, memo) {
  const body = DocumentApp.openById(docId).getBody();
  const count = body.getNumChildren();
  let index = -1;
  for (let i = 0; i < count; i += 1) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    // 「## 紹介する商品」のように記号が付いていても拾えるようにする
    if (child.asParagraph().getText().indexOf(PRODUCT_HEADING) >= 0) {
      index = i;
      break;
    }
  }

  if (index < 0) {
    body.appendParagraph("");
    body.appendParagraph("## " + PRODUCT_HEADING);
    index = body.getNumChildren() - 1;
  }

  const line = "- " + name + " | " + url + (memo ? " | " + memo : "");
  body.insertParagraph(index + 1, line).setHeading(DocumentApp.ParagraphHeading.NORMAL);
}

/**
 * ふだんのネタを差し込む位置を決める。
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

/**
 * 見出しの段落かどうか。
 *
 * Google ドキュメントの見出し機能を使わず「## 書き方のヒント」のように
 * 記号を書いている場合があるので、先頭の # と記号を落としてから比べる。
 * ここを厳しくすると、追記が黙って末尾に落ちる。
 */
function paragraphStartsWith(child, needle) {
  if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
  const text = child.asParagraph().getText().replace(/^[\s#*>-]+/, "").trim();
  return text.indexOf(needle) === 0;
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
