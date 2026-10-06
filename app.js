"use strict";

const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dateLabel = (date) => date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
const money = (value) => currency.format(Number(value) || 0);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const icons = { "Grains": "🌾", "Dairy": "🥛", "Cooking": "🫒", "Snacks": "🍪", "Beverages": "☕", "Personal care": "🧴", "Household": "🧹", "Fresh produce": "🥬" };
const day = 86400000;
const today = new Date();
today.setHours(0, 0, 0, 0);
const isoDay = (offset) => {
  const date = new Date(today.getTime() - offset * day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

let sales = [];
let products = [];
let currentUser = null;
let chartInstances = [];
let inventoryQuery = "";
let inventoryStatus = "all";
let overviewRange = 30;
let analyticsRange = 30;
let profitRange = 30;
let toastTimer;
let currentPage = window.location.hash.slice(1) || "overview";

async function api(path, method = "GET", payload) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: payload ? { "Content-Type": "application/json" } : {},
      body: payload ? JSON.stringify(payload) : undefined
    });
  } catch {
    throw new Error("Unable to connect to the server. Please try again.");
  }

  let result;
  try {
    const text = await response.text();
    if (!text.trim()) throw new Error("Empty API response.");
    result = JSON.parse(text);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid API response.");
  } catch {
    throw new Error("Unable to connect to the server. Please try again.");
  }
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Your session has expired. Please log in again.");
  }
  if (!response.ok || result.success === false) {
    throw new Error(result.message || result.error || "The request could not be completed.");
  }
  return result;
}

async function loadWorkspace() {
  const data = await api("/api/bootstrap");
  currentUser = data.user;
  products = data.products;
  sales = data.sales;
  updateUserChrome();
}

function getProducts() {
  return products;
}

function getInventory() {
  const productList = getProducts();
  const names = [...new Set([...productList.map((product) => product.name), ...sales.map((row) => row.Product)])];

  return names.map((name) => {
    const product = productList.find((item) => item.name.toLowerCase() === name.toLowerCase());
    const rows = sales.filter((row) => row.Product === name);
    const last30 = rows.filter((row) => row.Date >= isoDay(29));
    const soldRecently = last30.reduce((sum, row) => sum + row.Quantity, 0);
    const weeklyDemand = soldRecently / (30 / 7);
    const stock = product ? Number(product.quantity) || 0 : Math.max(0, Math.round(weeklyDemand * 2.3));
    const reorder = product ? Number(product.reorderLevel) || 0 : Math.max(5, Math.ceil(weeklyDemand * 1.5));
    const category = product?.category || rows[0]?.Category || "Other";
    const cost = Number(product?.purchasePrice ?? rows[0]?.CostPrice ?? 0);
    const price = Number(product?.sellingPrice ?? rows[0]?.SellingPrice ?? 0);
    const sold = rows.reduce((sum, row) => sum + row.Quantity, 0);
    const revenue = rows.reduce((sum, row) => sum + row.Revenue, 0);
    let status = "Healthy";
    if (stock === 0) status = "Out of stock";
    else if (stock <= reorder) status = "Low stock";
    else if (product && stock >= Math.max(reorder * 4, soldRecently * 2.7)) status = "Overstocked";
    return { name, category, stock, reorder, cost, price, sold, revenue, profit: rows.reduce((sum, row) => sum + row.Quantity * (row.SellingPrice - row.CostPrice), 0), weeklyDemand, status };
  });
}

function getMetrics(days = 30) {
  const recent = sales.filter((row) => row.Date >= isoDay(days - 1));
  const previous = sales.filter((row) => row.Date >= isoDay(days * 2 - 1) && row.Date < isoDay(days - 1));
  const revenue = (rows) => rows.reduce((sum, row) => sum + row.Revenue, 0);
  const profit = (rows) => rows.reduce((sum, row) => sum + row.Quantity * (row.SellingPrice - row.CostPrice), 0);
  const inventory = getInventory();
  const todayRows = sales.filter((row) => row.Date === isoDay(0));
  const todayRevenue = revenue(todayRows);
  const todayPrevious = revenue(sales.filter((row) => row.Date === isoDay(1)));
  const growth = previous.length ? ((revenue(recent) - revenue(previous)) / Math.max(1, revenue(previous))) * 100 : 0;
  const todayGrowth = todayPrevious ? ((todayRevenue - todayPrevious) / todayPrevious) * 100 : 0;
  return { recent, previous, revenue: revenue(recent), previousRevenue: revenue(previous), profit: profit(recent), inventory, todayRows, todayRevenue, todayProfit: profit(todayRows), todayGrowth, growth };
}

function productSummary(rows = sales) {
  const map = new Map();
  for (const row of rows) {
    const item = map.get(row.Product) || { name: row.Product, category: row.Category, quantity: 0, revenue: 0, profit: 0 };
    item.quantity += row.Quantity;
    item.revenue += row.Revenue;
    item.profit += row.Quantity * (row.SellingPrice - row.CostPrice);
    map.set(row.Product, item);
  }
  return [...map.values()].sort((a, b) => b.quantity - a.quantity);
}

function dailySeries(days = 14, rows = sales) {
  return Array.from({ length: days }, (_, index) => {
    const offset = days - index - 1;
    const key = isoDay(offset);
    return { date: key, label: dateLabel(new Date(`${key}T12:00:00`)), revenue: rows.filter((row) => row.Date === key).reduce((sum, row) => sum + row.Revenue, 0), quantity: rows.filter((row) => row.Date === key).reduce((sum, row) => sum + row.Quantity, 0) };
  });
}

function pageHeading(title, subtitle, actions = "") {
  return `<div class="page-heading"><div><div class="eyebrow">YOUR BUSINESS AT A GLANCE</div><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
}

function metricCard(label, value, symbol, iconClass, change, caption = "vs. previous 30 days") {
  return `<article class="metric-card"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon ${iconClass}">${symbol}</span></div><div class="metric-value">${value}</div><div class="metric-foot"><span class="metric-change ${change.startsWith("-") ? "down" : ""}">${change}</span><span>${caption}</span></div></article>`;
}

function panelHeader(title, description, right = "") {
  return `<div class="panel-heading"><div><h2 class="panel-title">${title}</h2><p class="panel-description">${description}</p></div>${right}</div>`;
}

function statusBadge(status) {
  const css = status === "Healthy" ? "healthy" : status === "Out of stock" ? "out" : "low";
  return `<span class="status-badge ${css}">${escapeHtml(status)}</span>`;
}

function renderOverview() {
  const needsSetup = !products.length && !sales.length;
  const metrics = getMetrics(overviewRange);
  const rankedProducts = productSummary(metrics.recent);
  const inventory = metrics.inventory;
  const lowStock = inventory.filter((item) => item.status === "Low stock" || item.status === "Out of stock");
  const todayBest = productSummary(metrics.todayRows)[0];
  const pct = (value, previous) => previous ? `${value >= previous ? "+" : ""}${((value - previous) / previous * 100).toFixed(1)}%` : "—";
  const summaryTone = metrics.todayGrowth >= 0 ? "up" : "down";
  const summaryText = needsSetup
    ? "Your private workspace is ready. Add products and record sales to see your actual revenue, profit, and inventory trends here."
    : `Your business ${metrics.todayGrowth >= 0 ? "is off to a good start" : "has had a quieter day"} today. Sales are ${Math.abs(metrics.todayGrowth).toFixed(0)}% ${metrics.todayGrowth >= 0 ? "ahead of" : "below"} yesterday${todayBest ? `, with ${todayBest.name} leading the way at ${money(todayBest.revenue)}` : ""}. ${lowStock.length ? `${lowStock.length} products could use a stock check.` : "Your stock levels look good."}`;
  const insights = makeInsights();
  return `${pageHeading(`Good morning, ${escapeHtml(currentUser.name)} 👋`, `Here’s how ${escapeHtml(currentUser.businessName)} is performing today.`, `<select class="date-select" id="overview-range" aria-label="Dashboard date range"><option value="7" ${overviewRange === 7 ? "selected" : ""}>Last 7 days</option><option value="30" ${overviewRange === 30 ? "selected" : ""}>Last 30 days</option><option value="90" ${overviewRange === 90 ? "selected" : ""}>Last 90 days</option></select><button class="secondary-button" id="export-csv"><span>↓</span> Export report</button>`)}
    <section class="metrics-grid" aria-label="Key business metrics">
      ${metricCard("Total revenue", money(metrics.revenue), "↗", "", pct(metrics.revenue, metrics.previousRevenue), `vs. previous ${overviewRange} days`)}
      ${metricCard("Estimated profit", money(metrics.profit), "◈", "blue", pct(metrics.profit, metrics.previous.reduce((sum, row) => sum + row.Quantity * (row.SellingPrice - row.CostPrice), 0)), `vs. previous ${overviewRange} days`)}
      ${metricCard("Units sold", metrics.recent.reduce((sum, row) => sum + row.Quantity, 0).toLocaleString("en-IN"), "▤", "gold", `${rankedProducts.length} products`, "in your catalog")}
      ${metricCard("Need attention", lowStock.length, "!", "pink", `${inventory.filter((item) => item.status === "Out of stock").length} out of stock`, "items to review")}
    </section>
    <div class="business-identity">🏪 <strong>${escapeHtml(currentUser.businessName)}</strong><span>${escapeHtml(currentUser.businessType)}</span></div>
    ${needsSetup ? `<section class="welcome-panel overview-setup"><span class="welcome-icon">✳</span><div><h2>Welcome to BizVision AI, ${escapeHtml(currentUser.name)} 👋</h2><p>Your dashboard is connected to your private account. Add products and record your first sale to populate these metrics with your business data.</p></div><div class="setup-steps"><div><span>01</span><strong>🏢 Business information</strong><small>${escapeHtml(currentUser.businessName)}</small></div><div><span>02</span><strong>📦 Add products</strong><small>Build your inventory catalog</small></div><div><span>03</span><strong>📊 Add your first sale</strong><small>Track sales and stock automatically</small></div><div><span>04</span><strong>🤖 Get your first AI insight</strong><small>Insights improve as data grows</small></div></div><button class="primary-button welcome-action" id="setup-business"><span class="button-arrow">🚀</span> Set Up My Business</button></section>` : ""}
    <section class="summary-banner"><div class="summary-head"><div><span>TODAY'S BUSINESS SUMMARY</span><strong>A quick look at today's trading</strong></div><span class="summary-ai">✳ AI summary</span></div><div class="summary-quick"><div><small>Today's sales</small><strong>${money(metrics.todayRevenue)}</strong></div><div><small>Sales vs. yesterday</small><strong class="${summaryTone}">${metrics.todayGrowth >= 0 ? "+" : ""}${metrics.todayGrowth.toFixed(1)}%</strong></div><div><small>Top product</small><strong>${escapeHtml(todayBest?.name || "No sales yet")}</strong></div><div><small>Est. profit</small><strong>${money(metrics.todayProfit)}</strong></div></div><p>${escapeHtml(summaryText)}</p></section>
    <section class="overview-grid">
      <article class="panel">${panelHeader("Revenue over time", "A look at your daily sales performance.", `<div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i> Revenue</span></div>`)}<div class="chart-container"><canvas id="overview-chart" aria-label="Daily revenue chart"></canvas></div></article>
      <article class="panel insight-panel">${panelHeader("Your business pulse", "A quick read on where things stand.")}<div class="insight-score"><div class="score-ring"><strong>${Math.min(98, Math.max(61, Math.round(75 + metrics.growth / 5)))}</strong></div><div class="score-label"><strong>Looking healthy</strong><small>Based on your recent activity</small></div></div><div class="insight-list">${insights.slice(0, 2).map((item) => `<div class="insight-item"><span class="insight-mark ${item.warning ? "warn" : ""}">${item.icon}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div></div>`).join("")}</div><a class="text-link" href="#assistant" data-page="assistant">Explore your AI insights <span>→</span></a></article>
    </section>
    <section class="bottom-grid">
      <article class="panel">${panelHeader("Recent sales", "Your latest product sales at a glance.", `<a class="text-link" href="#analytics" data-page="analytics">View all →</a>`)}<div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>DATE</th><th>UNITS</th><th>REVENUE</th></tr></thead><tbody>${[...metrics.recent].sort((a, b) => b.Date.localeCompare(a.Date)).slice(0, 5).map((row) => `<tr><td><span class="product-cell"><span class="product-thumb">${icons[row.Category] || "📦"}</span>${escapeHtml(row.Product)}</span></td><td>${dateLabel(new Date(`${row.Date}T12:00:00`))}</td><td>${row.Quantity}</td><td class="price-cell">${money(row.Revenue)}</td></tr>`).join("")}</tbody></table></div></article>
      <article class="panel">${panelHeader("Best sellers", "The products your customers come back for.")}<div class="top-product-list">${rankedProducts.slice(0, 4).map((item, index) => `<div class="top-product"><span class="product-rank">${String(index + 1).padStart(2, "0")}</span><div class="product-info"><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} units sold</small><div class="progress-track"><div class="progress-fill" style="width:${Math.max(10, item.quantity / (rankedProducts[0]?.quantity || 1) * 100)}%"></div></div></div><span class="product-sales">${money(item.revenue)}</span></div>`).join("")}</div><a class="text-link" href="#analytics" data-page="analytics">See sales analytics <span>→</span></a></article>
    </section>`;
}

function renderAnalytics() {
  const metrics = getMetrics(analyticsRange);
  const products = productSummary(metrics.recent);
  const forecast = makeForecast();
  const forecastTotal = forecast.forecast.reduce((sum, item) => sum + item.revenue, 0);
  const lowest = [...products].sort((a, b) => a.quantity - b.quantity).slice(0, 4);
  return `${pageHeading("Sales analytics", "Find your best days, fastest movers, and opportunities to grow.", `<select class="date-select" id="analytics-range" aria-label="Analytics date range"><option value="7" ${analyticsRange === 7 ? "selected" : ""}>Last 7 days</option><option value="30" ${analyticsRange === 30 ? "selected" : ""}>Last 30 days</option><option value="90" ${analyticsRange === 90 ? "selected" : ""}>Last 90 days</option></select>`)}
    <section class="metrics-grid">
      ${metricCard(`Revenue · ${analyticsRange} days`, money(metrics.revenue), "↗", "", `${metrics.growth >= 0 ? "+" : ""}${metrics.growth.toFixed(1)}%`, `vs. previous ${analyticsRange} days`)}
      ${metricCard("Daily average", money(metrics.revenue / analyticsRange), "◷", "blue", "Per calendar day", `last ${analyticsRange} days`)}
      ${metricCard("Units sold", metrics.recent.reduce((sum, row) => sum + row.Quantity, 0).toLocaleString("en-IN"), "▤", "gold", `${products.length} products`, `last ${analyticsRange} days`)}
      ${metricCard("Best sales day", money(Math.max(...dailySeries(analyticsRange).map((item) => item.revenue))), "✦", "pink", "Revenue high", `last ${analyticsRange} days`)}
    </section>
    <section class="panel wide-panel">${panelHeader("Revenue & daily sales", `Daily revenue over the last ${analyticsRange} days.`, `<div class="chart-legend"><span class="legend-item"><i class="legend-dot"></i> Revenue</span></div>`)}<div class="chart-container chart-tall"><canvas id="analytics-chart" aria-label="Revenue and sales chart"></canvas></div></section>
    <section class="analytics-grid">
      <article class="panel">${panelHeader("Best-selling products", `Products ranked by units sold in the last ${analyticsRange} days.`)}<div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>UNITS</th><th>REVENUE</th><th>GROSS MARGIN</th></tr></thead><tbody>${products.slice(0, 7).map((item) => `<tr><td><span class="product-cell"><span class="product-thumb">${icons[item.category] || "📦"}</span>${escapeHtml(item.name)}</span></td><td>${item.quantity}</td><td class="price-cell">${money(item.revenue)}</td><td class="positive">${item.revenue ? Math.round(item.profit / item.revenue * 100) : 0}%</td></tr>`).join("")}</tbody></table></div></article>
      <article class="panel">${panelHeader("Sales by category", "Where your revenue is coming from.")}<div class="category-chart"><canvas id="category-chart" aria-label="Revenue by category chart"></canvas></div></article>
    </section>
    <section class="analytics-grid">
      <article class="panel">${panelHeader("Next 7 days, at a glance", "A simple estimate based on recent weekday sales.", `<span class="status-badge healthy">${money(forecastTotal)} estimated</span>`)}<div class="chart-container"><canvas id="forecast-chart" aria-label="Estimated revenue forecast for the next seven days"></canvas></div></article>
      <article class="panel">${panelHeader("Worth a closer look", "Ideas based on your recent sales.")}<div class="insight-list">${forecast.demand.length ? `<div class="insight-item"><span class="insight-mark warn">!</span><div><strong>Restock candidates</strong><p>${forecast.demand.slice(0, 3).map((item) => `${escapeHtml(item.name)} (${item.stock} left; about ${item.weeklyDemand.toFixed(1)} sold weekly)`).join("<br>")}</p></div></div>` : `<div class="insight-item"><span class="insight-mark">✓</span><div><strong>No urgent restock forecast</strong><p>Your currently low-stock products have limited recent demand.</p></div></div>`}<div class="insight-item"><span class="insight-mark warn">↓</span><div><strong>Lower-selling products</strong><p>${lowest.map((item) => `${escapeHtml(item.name)} · ${item.quantity} units`).join("<br>")}</p></div></div></div></article>
    </section>`;
}

function renderInventory() {
  const inventory = getInventory();
  const low = inventory.filter((item) => item.status === "Low stock").length;
  const out = inventory.filter((item) => item.status === "Out of stock").length;
  const categorySelect = `<select class="filter-select" id="stock-filter" aria-label="Filter inventory by stock status"><option value="all">All stock levels</option><option value="Low stock">Low stock</option><option value="Out of stock">Out of stock</option><option value="Healthy">Healthy</option><option value="Overstocked">Overstocked</option></select>`;
  return `${pageHeading("Inventory", "Stay ahead of stockouts and know what needs attention.", `<div class="heading-actions"><button class="primary-button" id="add-product-btn"><span class="button-arrow">＋</span> Add product</button><button class="secondary-button" id="product-export-btn"><span>↓</span> Export Excel</button><button class="secondary-button" id="product-import-btn"><span>↑</span> Import Excel</button></div>`) }
    <section class="metrics-grid">
      ${metricCard("Products tracked", inventory.length, "▦", "", `${new Set(inventory.map((item) => item.category)).size} categories`, "across your business")}
      ${metricCard("Low stock", low, "!", "gold", low ? "Restock recommended" : "All stock levels good", "at or below reorder level")}
      ${metricCard("Out of stock", out, "×", "pink", out ? "Needs your attention" : "Nothing to replenish", "currently unavailable")}
      ${metricCard("Healthy stock", inventory.filter((item) => item.status === "Healthy").length, "✓", "blue", "Ready for customers", "above reorder levels")}
    </section>
    ${low + out ? `<div class="profit-note"><strong>Stock heads-up:</strong> ${inventory.filter((item) => item.status === "Low stock" || item.status === "Out of stock").slice(0, 4).map((item) => `${escapeHtml(item.name)} (${item.status === "Out of stock" ? "out of stock" : `${item.stock} left`})`).join(" · ")}. Consider replenishing before your next busy day.</div>` : ""}
    <section class="panel">${panelHeader("Your product catalog", "Keep the catalog, supplier details, and reorder levels in sync with each sale.")}<div class="table-toolbar"><input id="inventory-search" class="table-search" type="search" placeholder="Search products or categories…" value="${escapeHtml(inventoryQuery)}" aria-label="Search inventory"><div>${categorySelect}</div></div><div class="table-wrap"><table class="inventory-table"><thead><tr><th>PRODUCT</th><th>CATEGORY</th><th>STOCK ON HAND</th><th>REORDER AT</th><th>UNIT COST</th><th>SELL PRICE</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody id="inventory-rows">${inventoryRows(inventory)}</tbody></table></div></section>`;
}

function inventoryRows(inventory) {
  const filtered = inventory.filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(inventoryQuery.toLowerCase()) && (inventoryStatus === "all" || item.status === inventoryStatus));
  if (!filtered.length) return `<tr><td colspan="8"><div class="empty-state">No products match your search.</div></td></tr>`;
  return filtered.map((item) => {
    const width = Math.min(100, item.stock / Math.max(1, item.reorder * 2) * 100);
    const stockClass = item.stock === 0 ? "is-out" : item.stock <= item.reorder ? "is-low" : "";
    const product = getProducts().find((catalogItem) => catalogItem.name.toLowerCase() === item.name.toLowerCase());
    const actionButtons = product ? `<div class="table-actions"><button class="mini-action" data-product-action="edit" data-product-id="${product.id}">Edit</button><button class="mini-action danger" data-product-action="delete" data-product-id="${product.id}">Delete</button></div>` : "";
    return `<tr><td><span class="product-cell"><span class="product-thumb">${icons[item.category] || "📦"}</span>${escapeHtml(item.name)}</span></td><td>${escapeHtml(item.category)}</td><td><span class="stock-cell"><strong>${item.stock}</strong><span class="stock-track"><span class="${stockClass}" style="width:${width}%"></span></span></span></td><td>${item.reorder} units</td><td>${money(item.cost)}</td><td class="price-cell">${money(item.price)}</td><td>${statusBadge(item.status)}</td><td>${actionButtons}</td></tr>`;
  }).join("");
}

function renderProfit() {
  const metrics = getMetrics(profitRange);
  const products = productSummary(metrics.recent).sort((a, b) => b.profit - a.profit);
  const cost = metrics.recent.reduce((sum, row) => sum + row.Quantity * row.CostPrice, 0);
  const margin = metrics.revenue ? metrics.profit / metrics.revenue * 100 : 0;
  return `${pageHeading("Profit analysis", "Understand which products make you money—and which could make more.", `<select class="date-select" id="profit-range"><option value="30" ${profitRange === 30 ? "selected" : ""}>Last 30 days</option><option value="90" ${profitRange === 90 ? "selected" : ""}>Last 90 days</option></select>`)}
    <div class="profit-summary"><div class="summary-card"><small>ESTIMATED GROSS PROFIT</small><strong>${money(metrics.profit)}</strong></div><div class="summary-card"><small>GROSS PROFIT MARGIN</small><strong>${margin.toFixed(1)}%</strong></div><div class="summary-card"><small>ESTIMATED COST OF GOODS</small><strong>${money(cost)}</strong></div></div>
    <p class="profit-note"><strong>Your numbers, simply:</strong> Estimated gross profit is the selling price minus the cost price for every unit sold. It does not include rent, wages, or other operating expenses.</p>
    <section class="analytics-grid"><article class="panel">${panelHeader("Profit by product", `Your gross profit from each product over the last ${profitRange} days.`)}<div class="chart-container chart-tall"><canvas id="profit-chart" aria-label="Profit by product chart"></canvas></div></article>
    <article class="panel">${panelHeader("Most profitable products", `Ranked by gross profit contribution over ${profitRange} days.`)}<div class="top-product-list">${products.slice(0, 6).map((item, index) => `<div class="top-product"><span class="product-rank">${String(index + 1).padStart(2, "0")}</span><div class="product-info"><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} units · ${item.revenue ? Math.round(item.profit / item.revenue * 100) : 0}% margin</small><div class="progress-track"><div class="progress-fill" style="width:${Math.max(8, item.profit / (products[0]?.profit || 1) * 100)}%"></div></div></div><span class="product-sales">${money(item.profit)}</span></div>`).join("") || `<div class="empty-state">Sales data will appear here.</div>`}</div></article></section>
    <section class="panel">${panelHeader("Product-level breakdown", "A simple view of the revenue, costs and profit you have earned.")}<div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>UNITS SOLD</th><th>REVENUE</th><th>EST. COST</th><th>EST. PROFIT</th><th>MARGIN</th></tr></thead><tbody>${products.map((item) => `<tr><td><span class="product-cell"><span class="product-thumb">${icons[item.category] || "📦"}</span>${escapeHtml(item.name)}</span></td><td>${item.quantity}</td><td>${money(item.revenue)}</td><td>${money(item.revenue - item.profit)}</td><td class="positive">${money(item.profit)}</td><td>${item.revenue ? (item.profit / item.revenue * 100).toFixed(1) : "0.0"}%</td></tr>`).join("")}</tbody></table></div></section>`;
}

function makeInsights() {
  const metrics = getMetrics();
  const products = productSummary(metrics.recent);
  const inventory = metrics.inventory;
  const low = inventory.filter((item) => item.status === "Low stock" || item.status === "Out of stock");
  const best = products[0];
  const daily = dailySeries(14);
  const firstWeek = daily.slice(0, 7).reduce((sum, item) => sum + item.revenue, 0);
  const secondWeek = daily.slice(7).reduce((sum, item) => sum + item.revenue, 0);
  const growth = firstWeek ? (secondWeek - firstWeek) / firstWeek * 100 : 0;
  const insights = [];
  if (low.length) insights.push({ icon: "!", warning: true, title: `${low.length} products need a stock check`, text: `${low.slice(0, 2).map((item) => item.name).join(" and ")} ${low.length === 1 ? "is" : "are"} at or below the reorder point.` });
  if (best) insights.push({ icon: "↗", title: `${best.name} is your best seller`, text: `${best.quantity} units sold in the last 30 days, bringing in ${money(best.revenue)}.` });
  insights.push({ icon: growth >= 0 ? "↑" : "↓", warning: growth < 0, title: growth >= 0 ? "Sales picked up this week" : "Sales cooled off this week", text: `${Math.abs(growth).toFixed(0)}% ${growth >= 0 ? "more" : "less"} revenue than the week before.` });
  const profitLeader = [...products].sort((a, b) => b.profit - a.profit)[0];
  if (profitLeader && profitLeader.name !== best?.name) insights.push({ icon: "✦", title: "Profit leader", text: `${profitLeader.name} generated ${money(profitLeader.profit)} estimated gross profit this month.` });
  return insights;
}

function makeForecast() {
  const history = dailySeries(28);
  const weekdayAverages = Array.from({ length: 7 }, (_, weekday) => {
    const matching = history.filter((item) => new Date(`${item.date}T12:00:00`).getDay() === weekday);
    return matching.length ? matching.reduce((sum, item) => sum + item.revenue, 0) / matching.length : 0;
  });
  const forecast = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getTime() + (index + 1) * day);
    return { date, revenue: weekdayAverages[date.getDay()] };
  });
  return { forecast, demand: getInventory().filter((item) => (item.status === "Low stock" || item.status === "Out of stock") && item.weeklyDemand > 0).sort((a, b) => b.weeklyDemand - a.weeklyDemand) };
}

function assistantResponse(message) {
  const text = message.toLowerCase();
  const products = productSummary(getMetrics().recent);
  const inventory = getInventory();
  const best = products[0];
  const low = inventory.filter((item) => item.status === "Low stock" || item.status === "Out of stock");
  const profitable = [...products].sort((a, b) => b.profit - a.profit);
  const declining = products.map((product) => {
    const recent = sales.filter((row) => row.Product === product.name && row.Date >= isoDay(13)).reduce((sum, row) => sum + row.Quantity, 0);
    const earlier = sales.filter((row) => row.Product === product.name && row.Date >= isoDay(27) && row.Date < isoDay(13)).reduce((sum, row) => sum + row.Quantity, 0);
    return { ...product, recent, earlier, change: earlier ? (recent - earlier) / earlier * 100 : 0 };
  }).sort((a, b) => a.change - b.change);
  const growth = getMetrics().growth;
  if (/restock|low stock|reorder|inventory|stock/.test(text)) {
    if (!low.length) return "Your catalog looks well stocked at the moment. Keep an eye on fast-moving products and check again after your next busy day.";
    return `Here’s what I’d put on your restock list:\n${low.slice(0, 5).map((item) => `• ${item.name}: ${item.stock === 0 ? "out of stock" : `${item.stock} left`} (reorder point: ${item.reorder}). ${item.weeklyDemand ? `Customers buy about ${item.weeklyDemand.toFixed(1)} each week.` : ""}`).join("\n")}\n\nI’d start with ${low[0].name}, which has the most urgent stock position.`;
  }
  if (/best.sell|popular|top product|sell the most/.test(text)) {
    return `Your best sellers over the last 30 days:\n${products.slice(0, 5).map((item, index) => `${index + 1}. ${item.name} — ${item.quantity} units, ${money(item.revenue)} in sales`).join("\n")}\n\n${best ? `${best.name} is leading the way. ` : ""}These products may be good candidates for a weekend display.`;
  }
  if (/profit|profitable|margin/.test(text)) {
    const metrics = getMetrics();
    return `Your estimated gross profit for the last 30 days is ${money(metrics.profit)} (${metrics.revenue ? (metrics.profit / metrics.revenue * 100).toFixed(1) : "0.0"}% gross margin).\n\nYour top profit contributors:\n${profitable.slice(0, 4).map((item, index) => `${index + 1}. ${item.name} — ${money(item.profit)} profit`).join("\n")}\n\nThis is before rent, wages, and other operating costs.`;
  }
  if (/decreas|declin|drop|slow|fall/.test(text)) {
    const item = declining[0];
    return `Across all products, revenue is ${Math.abs(growth).toFixed(1)}% ${growth >= 0 ? "higher" : "lower"} than the previous 30 days.\n\n${item ? `${item.name} shows the biggest unit-sales dip in this sample (${item.recent} units in the last two weeks versus ${item.earlier} the two weeks before). ` : ""}Check whether popular items went out of stock, and compare weekday patterns before changing prices.`;
  }
  if (/promot|market|campaign|this week/.test(text)) {
    const lowProfit = [...products].sort((a, b) => a.quantity - b.quantity).filter((item) => item.quantity > 0)[0];
    return `A few practical ideas based on your sales:\n${best ? `• Put ${best.name} where customers can spot it—it’s your current best seller.\n` : ""}${low.length ? `• Replenish ${low[0].name} before featuring it in a promotion.\n` : ""}${lowProfit ? `• Try a small bundle featuring ${lowProfit.name} alongside a popular product, then see how it sells.\n` : ""}Start with a one-week test and compare the results with the previous week.`;
  }
  if (/forecast|predict|future|demand|next week/.test(text)) {
    const { forecast, demand } = makeForecast();
    const total = forecast.reduce((sum, item) => sum + item.revenue, 0);
    return `Using recent weekday sales as a simple guide, I estimate about ${money(total)} in revenue over the next 7 days.\n\n${demand.length ? `Watch these products: ${demand.slice(0, 3).map((item) => `${item.name} (around ${item.weeklyDemand.toFixed(1)} units/week, with ${item.stock} in stock)`).join("; ")}.` : "No products are currently both low-stock and selling at a meaningful pace."}\n\nThis is a simple historical average, not a guarantee—seasonality and one-off events can change demand.`;
  }
  if (/today|summary|perform|business|doing/.test(text)) {
    const metrics = getMetrics();
    const lowCount = low.length;
    return `Here’s your business snapshot:\n• Today's sales: ${money(metrics.todayRevenue)}${metrics.todayGrowth ? ` (${metrics.todayGrowth > 0 ? "+" : ""}${metrics.todayGrowth.toFixed(0)}% vs. yesterday)` : ""}\n• Estimated gross profit today: ${money(metrics.todayProfit)}\n• Best seller this month: ${best?.name || "No sales yet"}\n• Products to restock: ${lowCount}\n• Revenue this month: ${money(metrics.revenue)}\n\n${growth >= 0 ? "Sales are trending in the right direction." : "Revenue is softer than the previous 30 days; your analytics page can help spot the pattern."}`;
  }
  return `I can help you make sense of your sales and stock. Try asking:\n• Which products should I restock?\n• What are my best-selling products?\n• Which products make the most profit?\n• What should I promote this week?\n• Can you forecast next week's demand?\n\nI’ll answer using your private business data.`;
}

function renderAssistant() {
  const suggestions = ["Which products should I restock?", "What are my best sellers?", "Which products make the most profit?", "Can you forecast next week's demand?"];
  return `${pageHeading("Your AI business assistant", "Ask a question in plain language. Get an answer rooted in your numbers.", `<span class="data-status"><span class="status-dot"></span>Grounded in your business data</span>`)}
    <section class="assistant-layout"><article class="panel chat-panel"><header class="chat-header"><span class="ai-avatar">✳</span><div><strong>BizVision AI</strong><small>Your numbers, made simple</small></div><span class="chat-online" title="Ready"></span></header><div class="chat-messages" id="chat-messages"><div class="chat-message">Hi! I’ve been looking at your business data. Ask me about sales, products, profits, or what to restock next.<small>BizVision AI · just now</small></div></div><form class="chat-composer" id="chat-form"><input class="chat-input" id="chat-input" placeholder="Ask anything about your business…" autocomplete="off" required aria-label="Ask a business question"><button class="chat-submit" aria-label="Send message">↑</button></form></article>
    <aside class="panel"><h2 class="assistant-side-title">A few good questions</h2><div class="suggestion-list">${suggestions.map((question) => `<button class="suggestion" type="button">${escapeHtml(question)}</button>`).join("")}</div><div class="source-note"><strong>How this works</strong><br>Answers are generated from your sales and inventory data using a built-in demo assistant. Connect an AI provider later to use a real language model.</div></aside></section>`;
}

function renderForecast() {
  const { forecast, demand } = makeForecast();
  const expected = forecast.reduce((sum, item) => sum + item.revenue, 0);
  return `${pageHeading("Demand forecast", "A practical estimate based on your recent sales and inventory.", `<a class="secondary-button" href="#analytics" data-page="analytics">View sales analytics →</a>`)}
    <section class="metrics-grid">${metricCard("Forecast revenue", money(expected), "🔮", "blue", "Next 7 days", "based on weekday averages")}${metricCard("Restock candidates", demand.length, "!", "gold", "Demand and stock considered", "products to review")}${metricCard("Products tracked", products.length, "▦", "", "Your catalog", "in this workspace")}${metricCard("Sales records", sales.length, "◔", "pink", "Saved to your account", "across all dates")}</section>
    <section class="analytics-grid"><article class="panel">${panelHeader("Expected revenue", "Estimated daily revenue for the next seven days.")}<div class="chart-container chart-tall"><canvas id="forecast-page-chart" aria-label="Seven-day business revenue forecast"></canvas></div></article>
    <article class="panel">${panelHeader("Inventory to watch", "Reorder suggestions use recent sales velocity and current stock.")}<div class="insight-list">${demand.length ? demand.slice(0, 8).map((item) => `<div class="insight-item"><span class="insight-mark warn">!</span><div><strong>${escapeHtml(item.name)} · ${item.stock} left</strong><p>About ${item.weeklyDemand.toFixed(1)} sold weekly. Reorder point: ${item.reorder}.</p></div></div>`).join("") : `<div class="empty-state">Add products and record sales to get personalized demand and restock forecasts.</div>`}</div></article></section>`;
}

function renderReports() {
  const metrics = getMetrics(30);
  const best = productSummary(metrics.recent)[0];
  return `${pageHeading("Business reports", "Review your account's recent performance or download your sales records.", `<button class="primary-button" id="export-csv"><span>↓</span> Export sales report</button>`)}
    <section class="metrics-grid">${metricCard("Revenue · 30 days", money(metrics.revenue), "↗", "", `${sales.length} records`, "in your private workspace")}${metricCard("Estimated gross profit", money(metrics.profit), "◈", "blue", "Product margin", "before operating expenses")}${metricCard("Products sold", metrics.recent.reduce((sum, row) => sum + row.Quantity, 0), "▤", "gold", `${productSummary(metrics.recent).length} products`, "during the last 30 days")}${metricCard("Best seller", escapeHtml(best?.name || "—"), "✦", "pink", best ? `${best.quantity} units` : "No sales yet", "during the last 30 days")}</section>
    <section class="panel">${panelHeader("Your recent sales", "These records belong to your signed-in business account.", `<a class="text-link" href="#daily-sales" data-page="daily-sales">Record a sale →</a>`)}<div class="table-wrap"><table><thead><tr><th>DATE</th><th>PRODUCT</th><th>UNITS</th><th>REVENUE</th></tr></thead><tbody>${[...sales].slice(0, 20).map((row) => `<tr><td>${escapeHtml(row.Date)}</td><td>${escapeHtml(row.Product)}</td><td>${row.Quantity}</td><td>${money(row.Revenue)}</td></tr>`).join("") || `<tr><td colspan="4"><div class="empty-state">Your sales records will appear here.</div></td></tr>`}</tbody></table></div></section>`;
}

function renderSettings() {
  const typeOptions = ["Retail / Shop", "Shopping Mall", "Real Estate", "Restaurant / Café", "Hotel", "Salon / Beauty", "Pharmacy", "Automobile", "Manufacturing", "Wholesale / Distribution", "E-Commerce", "Education", "Technology / Startup", "Professional Services", "Other"];
  return `${pageHeading("Account settings", "Manage your profile and business information.")}<section class="panel settings-panel">${panelHeader("Your profile", "Keep your account details up to date.")}<form id="profile-form" class="biz-form settings-form"><div class="form-grid"><label><span>👤 Full name</span><input name="name" autocomplete="name" maxlength="100" value="${escapeHtml(currentUser.name)}" required></label><label><span>📧 Email address</span><input name="email" type="email" autocomplete="email" maxlength="254" value="${escapeHtml(currentUser.email)}" required></label><label><span>📱 Mobile number</span><input name="phone" type="tel" autocomplete="tel" maxlength="30" value="${escapeHtml(currentUser.phone)}" required></label><label><span>🏢 Business name</span><input name="businessName" autocomplete="organization" maxlength="120" value="${escapeHtml(currentUser.businessName)}" required></label><label><span>🏷️ Business type</span><select name="businessType" required>${typeOptions.map((type) => `<option value="${escapeHtml(type)}" ${currentUser.businessType === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}</select></label></div><div class="form-actions"><button class="primary-button" type="submit">Save account settings</button></div></form></section><section class="account-security"><span>🔒</span><div><strong>Your data belongs to you.</strong><p>Your profile, inventory, and sales are saved privately to your account.</p></div><button class="logout-button" id="settings-logout" type="button">🚪 Logout</button></section>`;
}

function renderDailySales() {
  const inventory = getInventory();
  const lowStock = inventory.filter((item) => item.status === "Low stock" || item.status === "Out of stock");
  const recentSales = [...sales].sort((a, b) => b.Date.localeCompare(a.Date)).slice(0, 6);
  const todayType = sales.filter((row) => row.Date === isoDay(0));
  const todayRevenue = todayType.reduce((sum, row) => sum + row.Revenue, 0);
  const productOptions = getProducts().map((product) => `<option value="${escapeHtml(product.name)}">${escapeHtml(product.name)} · ${product.quantity} left</option>`).join("");
  const bestSeller = productSummary(todayType)[0];

  return `${pageHeading("Daily sales", "Record every item sold today. Each entry updates stock and saves automatically.", `<button class="secondary-button" id="daily-sales-export"><span>↓</span> Export sales</button>`) }
    <section class="metrics-grid">
      ${metricCard("Today's sales", money(todayRevenue), "↗", "", `${bestSeller ? `Top: ${escapeHtml(bestSeller.name)}` : "No sales yet"}`, "update from today")}
      ${metricCard("Products sold", todayType.reduce((sum, row) => sum + row.Quantity, 0), "▤", "gold", `${productSummary(todayType).length} items`, "today")}
      ${metricCard("Low stock items", lowStock.length, "!", "pink", lowStock.length ? "Restock soon" : "No urgent alerts", "from your catalog")}
      ${metricCard("Best seller", bestSeller ? escapeHtml(bestSeller.name) : "—", "✦", "blue", bestSeller ? money(bestSeller.revenue) : "No revenue", "today")}
    </section>
    <section class="analytics-grid">
      <article class="panel">
        ${panelHeader("Add daily sales", "Choose a product, enter the quantity sold, and save the entry.")}
        <form id="daily-sale-form" class="biz-form">
          <div class="form-grid">
            <label><span>Date</span><input type="date" name="date" value="${isoDay(0)}" required></label>
            <label><span>Product</span><select name="product" required>${productOptions || "<option>No products yet</option>"}</select></label>
            <label><span>Sold quantity</span><input type="number" name="quantity" min="1" value="1" required></label>
          </div>
          <div class="form-actions"><button class="primary-button" type="submit"><span class="button-arrow">✓</span> Save sale</button></div>
        </form>
      </article>
      <article class="panel">
        ${panelHeader("Recent entries", "Your latest sales records are saved securely to your account.")}
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>PRODUCT</th><th>QTY</th><th>REVENUE</th></tr></thead>
            <tbody>
              ${recentSales.length ? recentSales.map((row) => `<tr><td>${row.Date}</td><td>${escapeHtml(row.Product)}</td><td>${row.Quantity}</td><td>${money(row.Revenue)}</td></tr>`).join("") : `<tr><td colspan="4"><div class="empty-state">No sales recorded yet.</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </article>
    </section>`;
}

async function handleDailySaleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const date = form.date.value || isoDay(0);
  const productName = form.product.value;
  const quantity = Number(form.quantity.value);
  const product = getProducts().find((item) => item.name === productName);

  if (!product) {
    showToast("Please select a product first.");
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    showToast("Quantity must be greater than zero.");
    return;
  }
  if (product.quantity < quantity) {
    showToast(`Only ${product.quantity} units of ${product.name} are currently in stock.`);
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/sales", "POST", { productId: product.id, quantity, date });
    product.quantity -= quantity;
    sales = [result.sale, ...sales];
    render();
    showToast(`Saved ${quantity} ${product.name} sale${quantity > 1 ? "s" : ""}.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

function openProductModal(product = null) {
  const productId = product ? product.id : "";
  const title = product ? "Edit product" : "Add new product";
  const modalHtml = `
    <div class="modal-backdrop" id="product-modal-backdrop">
      <div class="modal-card">
        <div class="modal-header">
          <div>
            <p class="eyebrow">PRODUCT MANAGEMENT</p>
            <h3>${title}</h3>
          </div>
          <button type="button" class="icon-button modal-close" id="product-modal-close" aria-label="Close product modal">×</button>
        </div>
        <form id="product-form" data-product-id="${escapeHtml(productId)}">
          <div class="product-form-grid">
            <label><span>Product name</span><input name="name" value="${escapeHtml(product?.name || "")}" required></label>
            <label><span>Category</span><input name="category" value="${escapeHtml(product?.category || "")}" required></label>
            <label><span>Purchase price</span><input name="purchasePrice" type="number" min="0" step="0.01" value="${Number(product?.purchasePrice || 0)}" required></label>
            <label><span>Selling price</span><input name="sellingPrice" type="number" min="0" step="0.01" value="${Number(product?.sellingPrice || 0)}" required></label>
            <label><span>Quantity</span><input name="quantity" type="number" min="0" step="1" value="${Number(product?.quantity || 0)}" required></label>
            <label><span>Reorder level</span><input name="reorderLevel" type="number" min="0" step="1" value="${Number(product?.reorderLevel || 0)}" required></label>
            <label class="full-width"><span>Supplier</span><input name="supplier" value="${escapeHtml(product?.supplier || "")}" required></label>
          </div>
          <div class="form-actions">
            <button type="button" class="secondary-button" id="cancel-product-modal">Cancel</button>
            <button class="primary-button" type="submit"><span class="button-arrow">✓</span> Save product</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
  document.getElementById("product-form").addEventListener("submit", handleProductSubmit);
  document.getElementById("product-modal-close").addEventListener("click", closeProductModal);
  document.getElementById("cancel-product-modal").addEventListener("click", closeProductModal);
  document.getElementById("product-modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "product-modal-backdrop") closeProductModal();
  });
}

function closeProductModal() {
  const modal = document.getElementById("product-modal-backdrop");
  if (modal) modal.remove();
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const productId = form.dataset.productId;
  const editing = Boolean(productId);
  const payload = {
    name: String(form.name.value).trim(),
    category: String(form.category.value).trim() || "General",
    purchasePrice: Number(form.purchasePrice.value),
    sellingPrice: Number(form.sellingPrice.value),
    quantity: Number(form.quantity.value),
    reorderLevel: Number(form.reorderLevel.value),
    supplier: String(form.supplier.value).trim() || "Local supplier"
  };

  if (!payload.name) {
    showToast("Product name is required.");
    return;
  }
  if (![payload.purchasePrice, payload.sellingPrice, payload.quantity, payload.reorderLevel].every((value) => Number.isFinite(value) && value >= 0)) {
    showToast("Prices, quantity, and reorder level must be valid numbers.");
    return;
  }
  if (payload.sellingPrice <= payload.purchasePrice) {
    showToast("Selling price should be higher than purchase price for healthy margins.");
    return;
  }

  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api(editing ? `/api/products/${encodeURIComponent(productId)}` : "/api/products", editing ? "PUT" : "POST", payload);
    const updated = result.product;
    const existingIndex = products.findIndex((item) => item.id === updated.id);
    if (existingIndex >= 0) products[existingIndex] = updated;
    else products = [updated, ...products];
    closeProductModal();
    render();
    showToast(editing ? "Product updated successfully." : "Product added successfully.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
}

async function deleteProduct(productId) {
  const product = products.find((item) => item.id === productId);
  if (!product) return;
  const confirmed = window.confirm(`Delete ${product.name} from your inventory?`);
  if (!confirmed) return;
  try {
    await api(`/api/products/${encodeURIComponent(productId)}`, "DELETE");
    products = products.filter((item) => item.id !== productId);
    render();
    showToast(`${product.name} was removed.`);
  } catch (error) {
    showToast(error.message);
  }
}

function exportProductsCsv() {
  const rows = [["Product Name", "Category", "Purchase Price", "Selling Price", "Quantity", "Reorder Level", "Supplier"], ...products.map((item) => [item.name, item.category, item.purchasePrice, item.sellingPrice, item.quantity, item.reorderLevel, item.supplier])];
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "bizvision-products.csv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Inventory export is ready.");
}

function parseProductCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim());
  if (!rows.length) throw new Error("The product CSV is empty.");
  const headers = rows[0].split(",").map((item) => item.replace(/^"|"$/g, "").trim().toLowerCase());
  const required = ["product name", "category", "purchase price", "selling price", "quantity", "reorder level", "supplier"];
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length) throw new Error(`Missing product CSV fields: ${missing.join(", ")}.`);

  const records = rows.slice(1).map((line) => {
    const cells = line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
    const record = Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
    return {
      name: record["product name"],
      category: record.category || "General",
      purchasePrice: Number(record["purchase price"]),
      sellingPrice: Number(record["selling price"]),
      quantity: Number(record.quantity),
      reorderLevel: Number(record["reorder level"]),
      supplier: record.supplier || "Local supplier"
    };
  }).filter((item) => item.name && Number.isFinite(item.purchasePrice) && Number.isFinite(item.sellingPrice) && Number.isFinite(item.quantity) && Number.isFinite(item.reorderLevel));

  if (!records.length) throw new Error("No valid product rows were found in the CSV file.");
  return records;
}

function setupInventoryActions() {
  const addButton = document.getElementById("add-product-btn");
  if (addButton) addButton.addEventListener("click", () => openProductModal());

  const importButton = document.getElementById("product-import-btn");
  if (importButton) importButton.addEventListener("click", () => document.getElementById("product-file").click());

  const exportButton = document.getElementById("product-export-btn");
  if (exportButton) exportButton.addEventListener("click", exportProductsCsv);

  document.querySelectorAll("[data-product-action]").forEach((button) => {
    const action = button.dataset.productAction;
    const productId = button.dataset.productId;
    if (action === "edit") button.addEventListener("click", () => {
      const product = products.find((item) => item.id === productId);
      if (product) openProductModal(product);
    });
    if (action === "delete") button.addEventListener("click", () => deleteProduct(productId));
  });

  const dailySalesExport = document.getElementById("daily-sales-export");
  if (dailySalesExport) dailySalesExport.addEventListener("click", exportCsv);

  const productFile = document.getElementById("product-file");
  if (productFile) {
    productFile.onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const parsed = parseProductCsv(await file.text());
        let imported = 0;
        for (const entry of parsed) {
          const existing = products.find((item) => item.name.toLowerCase() === entry.name.toLowerCase());
          const result = await api(existing ? `/api/products/${encodeURIComponent(existing.id)}` : "/api/products", existing ? "PUT" : "POST", entry);
          if (existing) products[products.indexOf(existing)] = result.product;
          else products.unshift(result.product);
          imported += 1;
        }
        render();
        showToast(`Imported ${imported} products.`);
      } catch (error) {
        showToast(error.message);
      } finally {
        event.target.value = "";
      }
    };
  }

  const saleForm = document.getElementById("daily-sale-form");
  if (saleForm) saleForm.addEventListener("submit", handleDailySaleSubmit);
}

const pageRenderers = { overview: renderOverview, "daily-sales": renderDailySales, analytics: renderAnalytics, inventory: renderInventory, profit: renderProfit, assistant: renderAssistant, forecast: renderForecast, reports: renderReports, settings: renderSettings };
const pageNames = { overview: "Overview", "daily-sales": "Daily sales", analytics: "Sales analytics", inventory: "Inventory", profit: "Profit analysis", assistant: "AI assistant", forecast: "Forecast", reports: "Reports", settings: "Settings" };

function render() {
  if (!pageRenderers[currentPage]) currentPage = "overview";
  chartInstances.forEach((chart) => chart.destroy());
  chartInstances = [];
  document.getElementById("page-content").innerHTML = pageRenderers[currentPage]();
  if (!document.getElementById("product-file")) {
    document.body.insertAdjacentHTML("beforeend", '<input type="file" id="product-file" accept=".csv,text/csv" hidden>');
  }
  document.getElementById("page-breadcrumb").textContent = pageNames[currentPage];
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === currentPage));
  const lowCount = getInventory().filter((item) => item.status === "Low stock" || item.status === "Out of stock").length;
  document.getElementById("low-stock-count").textContent = lowCount;
  document.getElementById("data-source-label").textContent = "Your private data";
  if (currentPage === "overview") drawOverviewChart();
  if (currentPage === "analytics") drawAnalyticsCharts();
  if (currentPage === "forecast") drawLineChart("forecast-page-chart", makeForecast().forecast.map((item) => ({ ...item, label: dateLabel(item.date) })), "Forecast revenue");
  if (currentPage === "profit") drawProfitChart();
  if (currentPage === "inventory") setupInventoryControls();
  if (currentPage === "assistant") setupAssistant();
  if (currentPage === "inventory" || currentPage === "daily-sales") setupInventoryActions();
  if (currentPage === "settings") setupProfileForm();
  const setupButton = document.getElementById("setup-business");
  if (setupButton) setupButton.addEventListener("click", () => {
    currentPage = "inventory";
    window.location.hash = "inventory";
    render();
    openProductModal();
  });
  const settingsLogout = document.getElementById("settings-logout");
  if (settingsLogout) settingsLogout.addEventListener("click", logout);
  setupExportButtons();
}

function updateUserChrome() {
  document.getElementById("sidebar-avatar").textContent = currentUser.name.slice(0, 1).toUpperCase();
  document.querySelector(".top-avatar").textContent = currentUser.name.slice(0, 1).toUpperCase();
  document.getElementById("sidebar-business").textContent = currentUser.businessName;
  document.getElementById("sidebar-user").textContent = currentUser.name;
}

function setupProfileForm() {
  const form = document.getElementById("profile-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    try {
      const result = await api("/api/profile", "PUT", payload);
      currentUser = result.user;
      updateUserChrome();
      render();
      showToast("Your account settings were updated.");
    } catch (error) {
      showToast(error.message);
    } finally {
      submit.disabled = false;
    }
  });
}

function chartDefaults() {
  return { responsive: true, maintainAspectRatio: false, animation: { duration: 300 }, plugins: { legend: { display: false }, tooltip: { backgroundColor: "#20382d", padding: 10, titleFont: { family: "DM Sans", size: 10 }, bodyFont: { family: "DM Sans", size: 10 }, callbacks: { label: (context) => ` ${money(context.parsed.y ?? context.parsed)}` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: "#9aa39f", maxRotation: 0, autoSkip: true, font: { family: "DM Sans", size: 9 } } }, y: { beginAtZero: true, border: { display: false, dash: [3, 4] }, grid: { color: "#eff2f0" }, ticks: { color: "#9aa39f", maxTicksLimit: 5, font: { family: "DM Sans", size: 9 }, callback: (value) => `₹${Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(Number(value) % 1000 ? 1 : 0)}k` : value}` } } } };
}

function drawLineChart(canvasId, series, label = "Revenue") {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  const context = canvas.getContext("2d");
  const fill = context.createLinearGradient(0, 0, 0, 230);
  fill.addColorStop(0, "rgba(39, 132, 91, .16)");
  fill.addColorStop(1, "rgba(39, 132, 91, 0)");
  chartInstances.push(new Chart(context, { type: "line", data: { labels: series.map((item) => item.label), datasets: [{ label, data: series.map((item) => item.revenue), borderColor: "#23845b", backgroundColor: fill, fill: true, borderWidth: 2, tension: .36, pointRadius: series.length > 20 ? 0 : 2, pointHoverRadius: 5, pointBackgroundColor: "#fff", pointBorderColor: "#23845b", pointBorderWidth: 2 }] }, options: chartDefaults() }));
}

function drawOverviewChart(range = overviewRange) { drawLineChart("overview-chart", dailySeries(Number(range))); }

function drawAnalyticsCharts(range = analyticsRange) {
  const series = dailySeries(Number(range));
  drawLineChart("analytics-chart", series);
  const canvas = document.getElementById("category-chart");
  if (canvas && window.Chart) {
    const categories = new Map();
    for (const row of getMetrics(Number(range)).recent) categories.set(row.Category, (categories.get(row.Category) || 0) + row.Revenue);
    chartInstances.push(new Chart(canvas.getContext("2d"), { type: "doughnut", data: { labels: [...categories.keys()], datasets: [{ data: [...categories.values()], backgroundColor: ["#31845e", "#9fcbb1", "#5475b2", "#e5bd73", "#9b83c0", "#e08d75", "#7eb7c3", "#a6ae8b"], borderWidth: 2, borderColor: "#fff", hoverOffset: 5 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: "69%", plugins: { legend: { position: "bottom", labels: { color: "#78857e", usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6, padding: 12, font: { family: "DM Sans", size: 9 } } }, tooltip: { callbacks: { label: (context) => ` ${context.label}: ${money(context.parsed)}` } } } } }));
  }
  drawForecastChart();
}

function drawForecastChart() {
  const canvas = document.getElementById("forecast-chart");
  if (!canvas || !window.Chart) return;
  const forecast = makeForecast().forecast;
  chartInstances.push(new Chart(canvas.getContext("2d"), { type: "line", data: { labels: forecast.map((item) => dateLabel(item.date)), datasets: [{ label: "Estimated revenue", data: forecast.map((item) => item.revenue), borderColor: "#5681bd", borderDash: [5, 4], backgroundColor: "rgba(86, 129, 189, .1)", fill: true, borderWidth: 2, tension: .35, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: "#fff", pointBorderColor: "#5681bd", pointBorderWidth: 2 }] }, options: chartDefaults() }));
}

function drawProfitChart() {
  const canvas = document.getElementById("profit-chart");
  if (!canvas || !window.Chart) return;
  const items = productSummary(getMetrics().recent).sort((a, b) => b.profit - a.profit).slice(0, 8);
  chartInstances.push(new Chart(canvas.getContext("2d"), { type: "bar", data: { labels: items.map((item) => item.name), datasets: [{ data: items.map((item) => item.profit), borderRadius: 5, backgroundColor: items.map((_, index) => index === 0 ? "#288259" : "#bad7c4"), maxBarThickness: 27 }] }, options: { ...chartDefaults(), indexAxis: "y", scales: { x: chartDefaults().scales.y, y: { grid: { display: false }, border: { display: false }, ticks: { color: "#6c7972", font: { family: "DM Sans", size: 9 } } } } } }));
}

function setupInventoryControls() {
  const search = document.getElementById("inventory-search");
  const filter = document.getElementById("stock-filter");
  search.addEventListener("input", () => { inventoryQuery = search.value; document.getElementById("inventory-rows").innerHTML = inventoryRows(getInventory()); });
  filter.addEventListener("change", () => { inventoryStatus = filter.value; document.getElementById("inventory-rows").innerHTML = inventoryRows(getInventory()); });
}

function appendMessage(message, isUser = false) {
  const container = document.getElementById("chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `chat-message${isUser ? " user" : ""}`;
  bubble.textContent = message;
  const time = document.createElement("small");
  time.textContent = isUser ? "You · just now" : "BizVision AI · just now";
  bubble.appendChild(time);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function sendChat(message) {
  const trimmed = message.trim();
  if (!trimmed) return;
  appendMessage(trimmed, true);
  window.setTimeout(() => appendMessage(assistantResponse(trimmed)), 220);
}

function setupAssistant() {
  document.getElementById("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("chat-input");
    sendChat(input.value);
    input.value = "";
  });
  document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => sendChat(button.textContent)));
}

function csvCell(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function exportCsv() {
  const rows = [["Date", "Product", "Category", "Quantity", "CostPrice", "SellingPrice", "Revenue"], ...sales.map((row) => [row.Date, row.Product, row.Category, row.Quantity, row.CostPrice, row.SellingPrice, row.Revenue])];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "bizvision-sales-report.csv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Your sales report is ready to download.");
}

function setupExportButtons() {
  document.querySelectorAll("#export-csv").forEach((button) => button.addEventListener("click", exportCsv));
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some((value) => value !== "")) records.push(row); }
  if (!records.length) throw new Error("This CSV file appears to be empty.");
  const headers = records.shift().map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
  const required = ["date", "product", "category", "quantity", "costprice", "sellingprice"];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}. Expected Date, Product, Category, Quantity, CostPrice and SellingPrice.`);
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const clean = records.map((cells, position) => {
    const value = (key) => cells[index[key]] || "";
    const date = value("date");
    const parsedDate = new Date(`${date}T00:00:00`);
    const quantity = Number(value("quantity"));
    const cost = Number(value("costprice"));
    const price = Number(value("sellingprice"));
    const product = value("product");
    const category = value("category") || "Other";
    if (!date || Number.isNaN(parsedDate.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Row ${position + 2}: Date must use YYYY-MM-DD.`);
    if (!product) throw new Error(`Row ${position + 2}: Product name cannot be blank.`);
    if (![quantity, cost, price].every(Number.isFinite) || !Number.isInteger(quantity) || quantity <= 0 || cost < 0 || price < 0) throw new Error(`Row ${position + 2}: Quantity must be a positive whole number and prices must be zero or greater.`);
    const revenue = value("revenue") === "" ? quantity * price : Number(value("revenue"));
    if (!Number.isFinite(revenue) || revenue < 0) throw new Error(`Row ${position + 2}: Revenue must be zero or greater.`);
    return { Date: date, Product: product, Category: category, Quantity: quantity, CostPrice: cost, SellingPrice: price, Revenue: revenue };
  });
  if (!clean.length) throw new Error("The CSV file contains headers but no sales rows.");
  return clean;
}

document.getElementById("upload-trigger").addEventListener("click", () => document.getElementById("csv-file").click());
document.getElementById("csv-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const parsed = parseCsv(await file.text());
    const result = await api("/api/sales/import", "POST", { sales: parsed });
    await loadWorkspace();
    inventoryQuery = "";
    inventoryStatus = "all";
    render();
    showToast(`Imported ${result.imported} sales records.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = "";
  }
});
document.getElementById("mobile-menu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-page]");
  if (link) {
    const page = link.dataset.page;
    if (page && page !== currentPage) {
      currentPage = page;
      window.location.hash = page;
      render();
    }
    document.getElementById("sidebar").classList.remove("open");
  }
});
window.addEventListener("hashchange", () => {
  const next = window.location.hash.slice(1) || "overview";
  if (next !== currentPage) { currentPage = next; render(); }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "overview-range") { overviewRange = Number(event.target.value); render(); }
  if (event.target.id === "analytics-range") { analyticsRange = Number(event.target.value); render(); }
  if (event.target.id === "profit-range") {
    profitRange = Number(event.target.value);
    render();
  }
});

async function logout() {
  try {
    await api("/api/logout", "POST", {});
    window.location.replace("/login");
  } catch (error) {
    showToast(error.message);
  }
}

document.getElementById("logout-button").addEventListener("click", logout);

window.addEventListener("pageshow", async (event) => {
  if (!event.persisted) return;
  document.documentElement.style.visibility = "hidden";
  try {
    await api("/api/me");
    document.documentElement.style.visibility = "";
  } catch {
    window.location.replace("/login");
  }
});

(async function startApp() {
  try {
    await loadWorkspace();
    render();
  } catch (error) {
    if (error.message !== "Your session has expired. Please log in again.") {
      document.getElementById("page-content").textContent = `BizVision AI could not load your workspace: ${error.message}`;
    }
  }
})();
