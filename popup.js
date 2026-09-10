const SUPABASE_URL = 'https://dsgjgnutkrwfgnrhfvnb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_YIbIGsNUjfdO1zI2PGoMUA_o8M4ahtn';
const SHARE_BASE_URL = 'https://capncook24.github.io/Threaded/view.html';

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getOrCreateWardrobeId() {
  const { wardrobeId } = await chrome.storage.local.get('wardrobeId');
  if (wardrobeId) return wardrobeId;

  const id = crypto.randomUUID();
  await supabaseFetch('wardrobes', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ id }),
  });
  await chrome.storage.local.set({ wardrobeId: id });
  return id;
}

// Every wardrobe belongs to a family from the moment it exists — even a family of
// one. That way there's only ever one kind of shareable link; "joining" just means
// merging your existing wardrobe into someone else's family instead of your own.
async function ensureFamilyId(wardrobeId) {
  const rows = await supabaseFetch(`wardrobes?id=eq.${wardrobeId}&select=family_id`);
  let familyId = rows?.[0]?.family_id || null;
  if (familyId) return familyId;

  const [family] = await supabaseFetch('families', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({}),
  });
  familyId = family.id;
  await supabaseFetch(`wardrobes?id=eq.${wardrobeId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ family_id: familyId }),
  });
  return familyId;
}

function extractProductInfo() {
  const host = location.hostname;
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
  const og = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content || null;

  // Per-site rules, tried first, since most retailers don't put price in meta tags.
  const siteRules = [
    {
      match: (h) => h.includes('zalando'),
      extract: () => {
        const brand = text('[data-testid="product_title-brand-name"]');
        const name = text('[data-testid="product_title-product-name"]');
        return {
          title: [brand, name].filter(Boolean).join(' - ') || null,
          price: document.querySelector('[data-testid="pdp-price-container"] span')?.textContent?.trim() || null,
        };
      },
    },
    {
      match: (h) => h.includes('zara.com'),
      extract: () => ({
        price: text('[data-qa-qualifier="price-amount-current"]'),
      }),
    },
    {
      match: (h) => h.includes('asos.com'),
      extract: () => ({
        title: text('[data-testid="product-title"]'),
        price: text('[data-testid="current-price"]'),
      }),
    },
    {
      match: (h) => h.includes('hm.com'),
      extract: () => ({
        title: text('[data-testid="product-name"]'),
        price: text('[data-testid="white-price"]'),
      }),
    },
    {
      // Uniqlo's own product:price:amount/currency meta tags are unreliable, and on
      // EU-locale pages the price is formatted "59,90 €" (currency after the number),
      // which the generic fallback regex below doesn't catch.
      match: (h) => h.includes('uniqlo.com'),
      extract: () => ({
        price: text('[class*="fr-ec-price-text--large"]'),
      }),
    },
    {
      // SHEIN's product:price:amount/currency meta tags are unreliable (often report
      // USD and a stale amount even on the UK site) — always use the on-page price,
      // scoped to .product-info so it can't pick up a recommended item's price instead.
      match: (h) => h.includes('shein.'),
      extract: () => {
        const scope = document.querySelector('.product-info .productPriceContainer');
        const match = scope?.textContent.match(/[€$£]\s?\d+[.,]\d{2}/);
        return { price: match ? match[0] : null };
      },
    },
    {
      match: (h) => h.includes('next.co.uk'),
      extract: () => ({
        title: text('[data-testid="product-title"]'),
        price: text('[data-testid="product-now-price"]'),
        image: document.querySelector('img[data-testid="image-carousel-slide"]')?.src || null,
      }),
    },
    {
      match: (h) => h.includes('vinted.'),
      extract: () => ({
        price: text('[data-testid="item-price"]'),
      }),
    },
    {
      match: (h) => h.includes('marksandspencer.com'),
      extract: () => ({
        price: Array.from(document.querySelectorAll('[class*="headingSm"]'))
          .map((el) => el.textContent.trim())
          .find((t) => /^£\d/.test(t)) || null,
      }),
    },
    {
      match: (h) => h.includes('boohoo.com'),
      extract: () => ({
        price: text('.text-markdown-colour'),
      }),
    },
    {
      match: (h) => h.includes('riverisland.com'),
      extract: () => {
        const img = document.querySelector('img[class*="carousel__image"]');
        return {
          title: text('h1'),
          price: text('[class*="product-details__price"]'),
          image: img?.getAttribute('data-src') || img?.src || null,
        };
      },
    },
    {
      // Amazon's markup is well-documented and fairly stable, but this rule is
      // best-effort/untested — Amazon blocks the automated browser this was built
      // with, so verify on a real product page and report back if it's off.
      match: (h) => h.includes('amazon.'),
      extract: () => {
        const img = document.querySelector('#landingImage') || document.querySelector('#imgTagWrapperId img');
        return {
          title: text('#productTitle'),
          price: text(
            '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, .a-price .a-offscreen'
          ),
          image: img?.src || null,
        };
      },
    },
    {
      // John Lewis doesn't set og:image at all, so the generic fallback below never
      // finds one — title and price already come through fine via that fallback.
      match: (h) => h.includes('johnlewis.com'),
      extract: () => ({
        image: document.querySelector('img[class*="ImageMagnifier"]')?.src || null,
      }),
    },
  ];

  let title = null;
  let price = null;
  let siteImage = null;

  const rule = siteRules.find((r) => r.match(host));
  if (rule) {
    const result = rule.extract();
    title = result.title || null;
    price = result.price || null;
    siteImage = result.image || null;
  }

  if (!title) title = og('og:title');
  let image = siteImage || og('og:image');
  if (!price) {
    const amount = og('product:price:amount');
    const currency = og('product:price:currency');
    if (amount) {
      price = currency === 'EUR' ? `€ ${amount}` : `${amount} ${currency || ''}`.trim();
    }
  }

  // WooCommerce fallback — common on small independent shops with no og: tags at all.
  // Scoped to .entry-summary so it doesn't pick up prices from a "related products" section.
  if (!title) title = text('.entry-summary .product_title, .entry-summary h1');
  if (!price) price = text('.entry-summary .price');
  if (!image) image = document.querySelector('.woocommerce-product-gallery img')?.src || null;

  if (!title) title = document.title;
  if (!price) {
    // Handles both "£12.34" / "€ 12,34" (symbol first) and "12,34 €" (symbol last, common
    // on EU-locale sites) so a site without its own rule above still gets a sane price.
    const match = document.body.innerText.match(
      /[€$£]\s?\d+(?:[.,]-|[.,]\d{2})|\d+[.,]\d{2}\s?[€$£]/
    );
    price = match ? match[0] : null;
  }

  return { title, price, image: image || null, url: location.href, site: host };
}

let currentItem = null;

async function loadPreview() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractProductInfo,
    });
  } catch (err) {
    // Chrome blocks extensions from reading its own internal pages (chrome://, the
    // Web Store, etc.) — that's expected, not a bug, so show a friendly message.
    document.getElementById('previewTitle').textContent = "Can't read this page";
    document.getElementById('previewPrice').textContent = 'Open a product page on a shopping site to save an item.';
    document.getElementById('saveBtn').disabled = true;
    return;
  }

  currentItem = result;

  document.getElementById('previewTitle').textContent = result.title || '(no title found)';
  document.getElementById('previewPrice').textContent = result.price || '(no price found)';
  document.getElementById('previewSite').textContent = result.site;

  const img = document.getElementById('previewImage');
  if (result.image) {
    img.src = result.image;
    img.hidden = false;
  }
}

async function renderSavedList() {
  const status = document.getElementById('status');
  let items = [];
  try {
    const wardrobeId = await getOrCreateWardrobeId();
    items = await supabaseFetch(
      `items?wardrobe_id=eq.${wardrobeId}&select=*&order=priority.desc,created_at.desc`
    );
  } catch (err) {
    status.textContent = `Couldn't load saved items: ${err.message}`;
    return;
  }

  document.getElementById('savedCount').textContent =
    `${items.length} item${items.length === 1 ? '' : 's'} saved`;

  const list = document.getElementById('savedList');
  list.innerHTML = '';

  items.forEach((item) => {
    const li = document.createElement('li');

    const img = document.createElement('img');
    img.src = item.image || '';

    const star = document.createElement('span');
    star.className = 'star';
    star.textContent = item.priority ? '★' : '☆';
    star.title = item.priority ? 'Really want this — click to unmark' : 'Mark as really want this';
    star.addEventListener('click', async () => {
      try {
        await supabaseFetch(`items?id=eq.${item.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ priority: !item.priority }),
        });
        renderSavedList();
      } catch (err) {
        status.textContent = `Couldn't update: ${err.message}`;
      }
    });

    const info = document.createElement('div');
    info.className = 'info';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = item.title || '(untitled)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [item.price, item.size, item.site].filter(Boolean).join(' · ');
    info.append(t, meta);
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'meta';
      note.style.fontStyle = 'italic';
      note.textContent = item.note;
      info.append(note);
    }

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async () => {
      try {
        await supabaseFetch(`items?id=eq.${item.id}`, { method: 'DELETE' });
        renderSavedList();
      } catch (err) {
        status.textContent = `Couldn't delete: ${err.message}`;
      }
    });

    li.append(img, star, info, removeBtn);
    list.appendChild(li);
  });
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!currentItem) return;
  const status = document.getElementById('status');
  const size = document.getElementById('sizeInput').value.trim();
  const note = document.getElementById('noteInput').value.trim();
  const priority = document.getElementById('priorityInput').checked;

  try {
    const savingToSelect = document.getElementById('savingToSelect');
    const wardrobeId = (!document.getElementById('savingToRow').hidden && savingToSelect.value)
      || (await getOrCreateWardrobeId());
    await supabaseFetch('items', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        wardrobe_id: wardrobeId,
        title: currentItem.title,
        price: currentItem.price,
        image: currentItem.image,
        url: currentItem.url,
        site: currentItem.site,
        size: size || null,
        note: note || null,
        priority,
      }),
    });
    status.textContent = 'Saved!';
    document.getElementById('priorityInput').checked = false;
    renderSavedList();
  } catch (err) {
    status.textContent = `Couldn't save: ${err.message}`;
  }
});

async function loadWardrobeName() {
  try {
    const wardrobeId = await getOrCreateWardrobeId();
    const rows = await supabaseFetch(`wardrobes?id=eq.${wardrobeId}&select=name`);
    document.getElementById('wardrobeNameInput').value = rows?.[0]?.name || '';
  } catch (err) {
    // Non-critical — leave the field blank if this fails.
  }
}

document.getElementById('wardrobeNameSaveBtn').addEventListener('click', async () => {
  const nameStatus = document.getElementById('wardrobeNameStatus');
  const name = document.getElementById('wardrobeNameInput').value.trim();
  try {
    const wardrobeId = await getOrCreateWardrobeId();
    await supabaseFetch(`wardrobes?id=eq.${wardrobeId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ name: name || null }),
    });
    nameStatus.textContent = 'Saved!';
  } catch (err) {
    nameStatus.textContent = `Couldn't save: ${err.message}`;
  }
});

async function loadFamilySection() {
  const familyStatus = document.getElementById('familyStatus');
  try {
    const wardrobeId = await getOrCreateWardrobeId();
    const familyId = await ensureFamilyId(wardrobeId);

    document.getElementById('familyCodeDisplay').value = familyId;

    const [family] = await supabaseFetch(`families?id=eq.${familyId}&select=event_label`);
    document.getElementById('eventLabelInput').value = family?.event_label || '';

    const members = await supabaseFetch(`wardrobes?family_id=eq.${familyId}&select=id,name`);
    const isGroup = members.length > 1;

    document.getElementById('savingToRow').hidden = !isGroup;

    const nameLabel = document.querySelector('label[for="wardrobeNameInput"]');
    nameLabel.textContent = isGroup ? 'Your name' : 'List name';

    const select = document.getElementById('savingToSelect');
    select.innerHTML = '';
    members.forEach((member) => {
      const option = document.createElement('option');
      option.value = member.id;
      option.textContent = member.id === wardrobeId
        ? `Me${member.name ? ` (${member.name})` : ''}`
        : member.name || 'Unnamed family member';
      select.appendChild(option);
    });
    select.value = wardrobeId;
  } catch (err) {
    familyStatus.textContent = `Couldn't load sharing info: ${err.message}`;
  }
}

document.getElementById('eventLabelSaveBtn').addEventListener('click', async () => {
  const eventLabelStatus = document.getElementById('eventLabelStatus');
  const label = document.getElementById('eventLabelInput').value.trim();
  try {
    const wardrobeId = await getOrCreateWardrobeId();
    const familyId = await ensureFamilyId(wardrobeId);
    await supabaseFetch(`families?id=eq.${familyId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ event_label: label || null }),
    });
    eventLabelStatus.textContent = 'Saved!';
  } catch (err) {
    eventLabelStatus.textContent = `Couldn't save: ${err.message}`;
  }
});

document.getElementById('joinFamilyBtn').addEventListener('click', async () => {
  const familyStatus = document.getElementById('familyStatus');
  const code = document.getElementById('joinFamilyInput').value.trim();
  if (!code) return;
  try {
    const found = await supabaseFetch(`families?id=eq.${encodeURIComponent(code)}&select=id`);
    if (!found || found.length === 0) {
      familyStatus.textContent = "Couldn't find a family with that code.";
      return;
    }
    const wardrobeId = await getOrCreateWardrobeId();
    await supabaseFetch(`wardrobes?id=eq.${wardrobeId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ family_id: code }),
    });
    familyStatus.textContent = 'Joined family!';
    loadFamilySection();
  } catch (err) {
    familyStatus.textContent = `Couldn't join family: ${err.message}`;
  }
});

document.getElementById('copyFamilyCodeBtn').addEventListener('click', async () => {
  const familyStatus = document.getElementById('familyStatus');
  try {
    await navigator.clipboard.writeText(document.getElementById('familyCodeDisplay').value);
    familyStatus.textContent = 'Code copied!';
  } catch (err) {
    familyStatus.textContent = `Couldn't copy code: ${err.message}`;
  }
});

document.getElementById('familyShareBtn').addEventListener('click', async () => {
  const familyShareStatus = document.getElementById('familyShareStatus');
  try {
    const familyId = document.getElementById('familyCodeDisplay').value;
    const link = `${SHARE_BASE_URL}?fam=${familyId}`;
    await navigator.clipboard.writeText(link);
    familyShareStatus.textContent = 'Link copied!';
  } catch (err) {
    familyShareStatus.textContent = `Couldn't copy link: ${err.message}`;
  }
});

loadPreview();
renderSavedList();
loadWardrobeName();
loadFamilySection();
