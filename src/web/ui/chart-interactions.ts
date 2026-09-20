/** Small progressive enhancement for the server-rendered chart primitives. */
export const APP_JS = `(() => {
  const roots = document.querySelectorAll('[data-chart-root]');

  function hide(root) {
    const tooltip = root.querySelector('[data-chart-tooltip]');
    if (!tooltip) return;
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.dataset.visible = 'false';
  }

  function show(root, point) {
    const tooltip = root.querySelector('[data-chart-tooltip]');
    const time = root.querySelector('[data-chart-tooltip-time]');
    const values = root.querySelector('[data-chart-tooltip-values]');
    if (!tooltip || !time || !values) return;

    time.textContent = point.dataset.chartTime || 'Time unavailable';
    values.replaceChildren();
    const timestamp = point.dataset.chartTimestamp;
    const matching = Array.from(root.querySelectorAll('[data-chart-point]')).filter((candidate) => candidate.dataset.chartTimestamp === timestamp);
    const points = matching.length > 0 ? matching : [point];
    for (const item of points) {
      const row = document.createElement('div');
      row.className = 'chart-tooltip-row';
      const indicator = document.createElement('span');
      indicator.className = 'chart-tooltip-indicator chart-series-' + (item.dataset.chartSeriesIndex || '1');
      indicator.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'chart-tooltip-label';
      label.textContent = item.dataset.chartSeries || 'Value';
      const value = document.createElement('strong');
      value.className = 'chart-tooltip-value';
      value.textContent = item.dataset.chartValue || 'Not available';
      row.append(indicator, label, value);
      values.append(row);
    }

    const pointX = Number(point.dataset.chartX || 0);
    tooltip.dataset.position = pointX < 180 ? 'left' : pointX > 500 ? 'right' : 'center';
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.dataset.visible = 'true';
  }

  for (const root of roots) {
    root.addEventListener('pointerover', (event) => {
      const point = event.target.closest?.('[data-chart-point]');
      if (point && root.contains(point)) show(root, point);
    });
    root.addEventListener('pointerleave', () => hide(root));
    root.addEventListener('focusin', (event) => {
      const point = event.target.closest?.('[data-chart-point]');
      if (point && root.contains(point)) show(root, point);
    });
    root.addEventListener('focusout', (event) => {
      if (!root.contains(event.relatedTarget)) hide(root);
    });
  }
})();`;
