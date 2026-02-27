const DELAY_BETWEEN_FETCHES = 700;
let fetchQueue = [];
let isFetching = false;

let userSettings = {
    showTotalFixedPrice: true,
    enableAdblock: true
};

// 스토리지에서 초기 설정 값 로드
chrome.storage.local.get(userSettings, (settings) => {
    userSettings = settings;
    if (userSettings.enableAdblock) {
        removeAdCards(); // 로드 시 광고 차단 실행
    }
});

// 설정 변경 감지
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.showTotalFixedPrice !== undefined) {
            userSettings.showTotalFixedPrice = changes.showTotalFixedPrice.newValue;
            // 이미 렌더링된 뱃지들의 텍스트를 모두 업데이트
            const allObserved = document.querySelectorAll('[data-bmc-processed], [data-bmc-observed]');
            allObserved.forEach(card => {
                card.removeAttribute('data-bmc-processed');
                card.removeAttribute('data-bmc-observed');
            });
            init(); // 뱃지 재주입
        }
        if (changes.enableAdblock !== undefined) {
            userSettings.enableAdblock = changes.enableAdblock.newValue;
            if (userSettings.enableAdblock) {
                removeAdCards();
            } else {
                // 광고 차단 해제 시 블라인드 클래스 제거
                const blindedAds = document.querySelectorAll('.bj-ad-blind');
                blindedAds.forEach(ad => ad.classList.remove('bj-ad-blind'));
            }
        }
    }
});

// 배송비 캐시 인메모리 저장소
let shippingCache = {};
try {
    chrome.storage.local.get(['bunjangShipping'], (res) => {
        if (res && res.bunjangShipping) {
            shippingCache = res.bunjangShipping;
        }
    });
} catch (e) {
    console.warn('[번개장터 플러스] Could not load cache (Context invalidated).');
}

/**
 * 상품 캐시를 저장합니다.
 * @param {string} productId 상품 ID
 * @param {Object} product 상품 정보
 */
function saveProductCache(productId, product) {
    try {
        // 상품 캐시가 5,000건을 초과할 경우 브라우저 렉(프리징) 및 메모리 누수를 막기 위해 캐시를 초기화합니다.
        if (Object.keys(shippingCache).length > 5000) {
            shippingCache = {};
            chrome.storage.local.remove('bunjangShipping');
        }

        // 스토리지 용량 절약을 위해 무거운 원본 대신 배송 정보만 추출하여 저장
        shippingCache[productId] = {
            trade: {
                freeShipping: product.trade?.freeShipping,
                shippingSpecs: product.trade?.shippingSpecs
            }
        };
        chrome.storage.local.set({ bunjangShipping: shippingCache });
    } catch (e) {
        // 확장 프로그램이 업데이트(새로고침)되어 기존 스크립트 연결이 끊어졌을 때 발생하는 에러 무시
        if (e.message.includes('Extension context invalidated')) {
            console.warn('[번개장터 플러스] Extension reloaded. Storage save bypassed until page refresh.');
        } else {
            console.error('[번개장터 플러스] Cache save error:', e);
        }
    }
}

/**
 * 가격을 포맷팅합니다.
 * @param {number} price 가격
 * @returns {string} 포맷팅된 문자열
 */
function formatPrice(price) {
  return price.toLocaleString() + ' 원';
}

/**
 * 가격 텍스트를 가져옵니다.
 * @param {number} fee 배송비
 * @param {number} originalPrice 원본 가격
 * @returns {string} 가격 텍스트
 */
function getPriceText(fee, originalPrice) {
    if (userSettings.showTotalFixedPrice) {
        return formatPrice(originalPrice + fee);
    } else {
        return `+${fee.toLocaleString()}원`;
    }
}

/**
 * API 호출 큐를 처리합니다.
 * @returns {Promise<void>}
 */
async function processFetchQueue() {
  if (isFetching || fetchQueue.length === 0) return;
  
  isFetching = true;
  const { productId, card, originalPrice } = fetchQueue.shift();

  try {
      // 세션 쿠키 여부와 관계없이 강제로 비로그인 유저(-1)로 API를 호출합니다.
      const apiUrl = `https://api.bunjang.co.kr/api/pms/v3/products-detail/${productId}?viewerUid=-1`;

      const response = await fetch(apiUrl);
      
      if (!response.ok) throw new Error(`API Response Error: ${response.status}`);
      
      const resData = await response.json();
      const product = resData.data?.product;
      
      if (product) {
          saveProductCache(productId, product); // Fetch 성공 시 캐시 저장
          injectPriceBadges(card, originalPrice, product); // originalPrice는 null이 아님이 보장됨
      } else {
          console.warn(`[번개장터 플러스] No data for PID: ${productId}`);
      }
  } catch (err) {
      console.error(`[번개장터 플러스] API Error (${productId}):`, err);
  } finally {
      setTimeout(() => {
        isFetching = false;
        processFetchQueue();
      }, DELAY_BETWEEN_FETCHES);
  }
}

/**
 * 가격 요소를 찾습니다.
 * @param {Element} card 상품 카드
 * @returns {Element} 가격 요소
 */
function findPriceElement(card) {
    const infoContainer = card.querySelector('div:nth-child(2)');
    if (infoContainer) {
        const priceRow = infoContainer.querySelector('div:nth-child(2)');
        if (priceRow) {
            const el = priceRow.querySelector('div:first-child');
            if (el && /^[0-9,]+원?$/.test(el.textContent.trim())) {
                return el;
            }
        }
    }

    const allNodes = card.querySelectorAll('div, span, p, strong, em');
    for (const node of allNodes) {
        const text = node.textContent.trim();
        // 내부 자식이 없는 순수 텍스트 노드이면서 숫자와 콤마(선택적 '원')로만 이루어진 것 찾기
        if (node.childElementCount === 0 && text && /^[0-9]+(,[0-9]{3})*원?$/.test(text)) {
            return node;
        }
    }
    return null;
}

/**
 * 추출한 가격 문자열("10,000원")을 정수(10000)로 변환
 * @param {string} priceText 가격 문자열
 * @returns {number} 정수 가격
 */ 
function parsePrice(priceText) {
  const num = priceText.replace(/[^0-9]/g, '');
  return parseInt(num, 10);
}

/**
 * 가격 뱃지 주입
 * @param {Element} card 상품 카드
 * @param {number} originalPrice 원본 가격
 * @param {Object} product 상품 정보
 */
function injectPriceBadges(card, originalPrice, product) {
  const priceDiv = findPriceElement(card);
  if (!priceDiv) return;

  // SPA 라우팅 시 뱃지가 중복으로 추가되지 않도록 기존 뱃지 컨테이너 초기화
  let wrapper = card.querySelector('.bj-custom-price-container');
  if (wrapper) wrapper.remove();
  
  wrapper = document.createElement('div');
  wrapper.className = 'bj-custom-price-container';

  const createBadge = (typeClass, labelParts, priceText) => {
    const b = document.createElement('span');
    b.className = `bj-custom-price-text ${typeClass}`;
    
    // labelParts가 문자열이면 배열로 변환
    const parts = typeof labelParts === 'string' ? [{ text: labelParts, class: 'bj-label' }] : labelParts;
    
    parts.forEach(part => {
        const l = document.createElement('span');
        l.className = part.class || 'bj-label';
        l.textContent = part.text;
        b.appendChild(l);
    });
    
    const p = document.createElement('span');
    p.className = 'bj-price';
    p.textContent = ` ${priceText}`;
    
    b.appendChild(p);
    return b;
  };

  // API 스펙 (pms/v3 기준)
  const specs = product.trade?.shippingSpecs || {};
  const isFree = product.trade?.freeShipping || false;

  if (isFree) {
    const label = userSettings.showTotalFixedPrice ? '' : '무료배송';
    const price = userSettings.showTotalFixedPrice ? formatPrice(originalPrice) : '';
    wrapper.appendChild(createBadge('free-shipping', label, price));
  } else {
    // 일반 배송비
    if (specs.DEFAULT && specs.DEFAULT.fee > 0) {
      wrapper.appendChild(createBadge('normal-shipping', '일반', getPriceText(specs.DEFAULT.fee, originalPrice)));
      
      // 줄바꿈용 (flex-break)
      const br = document.createElement('div');
      br.style.flexBasis = '100%';
      br.style.height = '0';
      wrapper.appendChild(br);
    }

    // 반값 택배 정보 합치기 (GS, CU)
    const gsFee = specs.GS_HALF_PRICE?.fee || 0;
    const cuFee = specs.CU_THRIFTY?.fee || specs.CU_THRIFTY?.fee || 0;
    const hasGS = gsFee > 0;
    const hasCU = cuFee > 0;

    if (hasGS || hasCU) {
      if (hasGS && hasCU) {
          wrapper.appendChild(createBadge('gs-cu-shipping', [
              { text: 'GS반값', class: 'bj-label gs-label' },
              { text: ' • ', class: 'bj-label separator' },
              { text: 'CU반값', class: 'bj-label cu-label' },
          ], getPriceText(gsFee, originalPrice)));
      } else if (hasGS) {
        wrapper.appendChild(createBadge('gs-shipping', 'GS반값', getPriceText(gsFee, originalPrice)));
      } else {
        wrapper.appendChild(createBadge('cu-shipping', 'CU반값', getPriceText(cuFee, originalPrice)));
      }
    }
    
    // 배송비 정보가 전혀 없는 경우
    if (wrapper.children.length === 0) {
        wrapper.appendChild(createBadge('unknown-shipping', '배송비별도', ''));
    }
  }

  // 가격, 올린 시간의 요소가 들어있는 부모 요소를 랩핑 가능하도록 만들어서, 크기가 100%인 뱃지 컨테이너가 다음줄로 내려가게 함
  const priceRow = priceDiv.parentElement;
  if (priceRow) {
      priceRow.style.flexWrap = 'wrap';
      priceRow.style.height = 'auto';
      priceRow.appendChild(wrapper);

      // 상품 카드의 부모 요소들이 고정 높이를 가지고 있어 아래 구분선과 겹치는 현상 방지
      const infoContainer = priceRow.parentElement;
      if (infoContainer) {
          infoContainer.style.height = 'auto';
      }
      
      const aTag = card.tagName === 'A' ? card : card.closest('a');
      if (aTag) {
          aTag.style.height = 'auto';
      }
  } else {
      priceDiv.insertAdjacentElement('afterend', wrapper);
  }
}

// 뷰포트 지연 로딩을 위한 Intersection Observer 설정
// 뷰포트 하단 300px 전부터 미리 로딩을 시작
const productObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const card = entry.target;
            observer.unobserve(card); // 화면에 들어왔으므로 관찰 해제
            processProductCardInternal(card);
        }
    });
}, { root: null, rootMargin: '0px 0px 300px 0px', threshold: 0 });

/**
 * 상품 카드를 처리합니다.
 * @param {Element} card 상품 카드
 */
function processProductCard(card) {
  const aTag = card.tagName === 'A' ? card : card.closest('a');
  if (!aTag || !aTag.href) return;
  
  const pidMatch = aTag.href.match(/\/products\/(\d+)/);
  if (!pidMatch) return;
  const productId = pidMatch[1];

  // 이미 이 상품ID에 대해 관찰이 설정되었으면 패스 (DOM 재활용(SPA) 대응)
  if (card.dataset.bmcObserved === productId) return;
  card.dataset.bmcObserved = productId;
  
  // SPA 라우팅 시 요소가 뷰포트 안에 이미 들어와 있는 채로 재활용되면
  // IntersectionObserver의 콜백이 (상태 변화가 없어) 동작하지 않는 한계가 있습니다.
  // 따라서 현재 화면에 보이는 요소는 즉시 처리하고, 아래쪽에 숨겨진 요소만 옵저버에 맡깁니다.
  const rect = card.getBoundingClientRect();
  const isVisible = rect.top <= (window.innerHeight + 300) && rect.bottom >= -300;
  
  if (isVisible) {
      processProductCardInternal(card);
  } else {
      productObserver.observe(card);
  }
}

/**
 * 상품 카드 내부를 처리합니다.
 * @param {Element} card 상품 카드
 */
function processProductCardInternal(card) {
  const aTag = card.tagName === 'A' ? card : card.closest('a');
  if (!aTag || !aTag.href) return;

  const pidMatch = aTag.href.match(/\/products\/(\d+)/);
  if (!pidMatch) return;
  const productId = pidMatch[1];

  // 이미 처리된 상품 ID라면 패스
  if (card.dataset.bmcProcessed === productId) return;

  // 리액트 등 SPA에서 DOM 요소를 재활용하는 경우 기존 뱃지 잔여물 제거
  const oldContainer = card.querySelector('.bj-custom-price-container');
  if (oldContainer) {
      oldContainer.remove();
  }

  // 1. 텍스트에 '배송비포함'이 이미 있는 경우 무료배송 뱃지 주입 후 패스
  if (card.textContent.includes('배송비포함')) {
      const priceElement = findPriceElement(card);
      if (priceElement) {
          const val = parseInt(priceElement.textContent.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(val)) {
              injectPriceBadges(card, val, { trade: { freeShipping: true } });
          }
      }
      card.dataset.bmcProcessed = productId;
      return;
  }

  const priceElement = findPriceElement(card);
  if (!priceElement) return;

  // 순수하게 가격 텍스트에서만 숫자를 추출 (상품명 숫자 등 혼입 방지)
  const val = parseInt(priceElement.textContent.replace(/[^0-9]/g, ''), 10);
  if (isNaN(val)) return;

  card.dataset.bmcProcessed = productId;

  // 2. 캐시 확인 로직
  if (shippingCache[productId]) {
      // 캐시가 존재하면 즉시 렌더링하고 종료 (API 큐에 넣지 않음)
      injectPriceBadges(card, val, shippingCache[productId]);
      return;
  }

  // 캐시가 없으면 Fetch 대기열에 추가
  fetchQueue.push({
    productId: productId,
    card: card,
    originalPrice: val
  });

  processFetchQueue();
}

/**
 * AD 뱃지는 남겨두고, 외부 사이트로 연결되는 '광고' 뱃지 카드만 찾아 제거합니다.
 */
function removeAdCards() {
    const allSpans = document.querySelectorAll('span');
    for (const span of allSpans) {
        if (span.childElementCount === 0 && span.textContent.trim() === '광고') {
            const aTag = span.closest('a');
            if (aTag && !aTag.classList.contains('bj-ad-blind')) {
                // 부모 요소(레이아웃 패딩 관련)를 제거하지 않고 a 태그 내부에 블라인드를 씌웁니다.
                aTag.classList.add('bj-ad-blind');
            }
        }
    }
}

/**
 * DOM 변경 사항을 감지하여 상품 카드를 처리합니다.
 */
function initDomObserver() {
  const domObserver = new MutationObserver((mutations) => {
    let adCheckNeeded = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) adCheckNeeded = true;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'A' && node.href && node.href.includes('/products/')) {
            processProductCard(node);
          } else {
            const cards = node.querySelectorAll("a[href*='/products/']");
            cards.forEach(processProductCard);
          }
        }
      }
    }
    if (adCheckNeeded) removeAdCards();
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
}

function init() {
//   removeAdCards(); // 초기 로딩 및 속성 변경 시 전체 광고카드 스캔 및 제거
  const cards = document.querySelectorAll("a[href*='/products/']");
  cards.forEach(processProductCard);
  
  // initObserver는 한 번만 실행되도록 중복 방지
  if (!window.bmcObserverInitialized) {
      initDomObserver();
      window.bmcObserverInitialized = true;
  }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// SPA 라우팅 환경 특성 상 카테고리 이동이나 검색 쿼리가 변경되었을 때,
// 페이지 전체가 다시 그려지는 대신 URL(혹은 QueryString)만 변경되고 비동기적으로 내용물(DOM)이 교체/재활용됩니다.
// 따라서 QueryString과 URL 변경을 주기적으로 추적하여, 기존 카드가 변경되었는지 감지하고 배지를 주입합니다.
let lastHref = location.href;
let lastSearch = location.search;

setInterval(() => {
    if (location.href !== lastHref || location.search !== lastSearch) {
        lastHref = location.href;
        lastSearch = location.search;
        
        // SPA 비동기 렌더링(DOM 재활용)이 진행되는 시간차를 고려하여, 
        // URL 업데이트 시점 직후에 시간 간격을 두고 순차적으로 뱃지 재설치를 시도합니다.
        setTimeout(init, 200);
    }
}, 1000);
