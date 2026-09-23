/** Small progressive enhancement for the server-rendered chart primitives. */
export const APP_JS = `(() => {
  const roots = document.querySelectorAll('[data-chart-root]');

  for (const form of document.querySelectorAll('form[action^="/settings/providers/"]')) {
    const preset = form.querySelector('[data-refresh-preset]');
    const custom = form.querySelector('[data-refresh-custom]');
    const customInput = custom?.querySelector('input');
    if (!preset || !custom || !customInput) continue;

    const syncCustomInterval = () => {
      const active = preset.value === 'custom';
      custom.hidden = !active;
      custom.open = active;
      customInput.disabled = !active;
    };
    preset.addEventListener('change', syncCustomInterval);
    syncCustomInterval();
  }

  for (const select of document.querySelectorAll('[data-chart-range-select]')) {
    select.addEventListener('change', () => {
      const form = select.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    });
  }

  function setPolicyFieldState(section, active) {
    section.hidden = !active;
    section.setAttribute('aria-hidden', active ? 'false' : 'true');
    for (const control of section.querySelectorAll('input, select, textarea, button')) {
      control.disabled = !active;
    }
  }

  for (const form of document.querySelectorAll('[data-policy-form]')) {
    const select = form.querySelector('[data-policy-kind]');
    const sections = Array.from(form.querySelectorAll('[data-policy-fields]'));
    if (!select) continue;

    const syncPolicyFields = () => {
      const selected = select.value;
      for (const section of sections) {
        setPolicyFieldState(section, section.dataset.policyFields === selected);
      }
    };

    select.addEventListener('change', syncPolicyFields);
    syncPolicyFields();
  }

  function renumberList(list) {
    for (const [index, item] of Array.from(list.querySelectorAll('[data-list-item]')).entries()) {
      const label = item.querySelector('label');
      const input = item.querySelector('[data-list-value]');
      if (!label || !input) continue;
      const kind = list.dataset.listKind === 'time' ? 'Time' : 'Period';
      const id = list.id + '-' + index;
      label.htmlFor = id;
      label.firstChild.textContent = kind + ' ' + (index + 1);
      input.id = id;
    }
  }

  for (const list of document.querySelectorAll('[data-schedule-list]')) {
    const add = list.querySelector('[data-list-add]');
    add?.addEventListener('click', () => {
      const item = document.createElement('div');
      item.className = 'dynamic-list-item';
      item.dataset.listItem = 'true';
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.name = list.dataset.listName || '';
      input.type = list.dataset.listKind === 'time' ? 'time' : 'text';
      input.required = true;
      input.dataset.listValue = 'true';
      if (list.dataset.listKind !== 'time') input.placeholder = '08:00-12:00';
      label.append(document.createTextNode(''), input);
      const remove = document.createElement('button');
      remove.className = 'button button-secondary dynamic-list-remove';
      remove.type = 'button';
      remove.dataset.listRemove = 'true';
      remove.textContent = 'Remove';
      item.append(label, remove);
      list.insertBefore(item, add);
      renumberList(list);
      input.focus();
    });
    list.addEventListener('click', (event) => {
      const remove = event.target.closest?.('[data-list-remove]');
      if (!remove) return;
      const items = list.querySelectorAll('[data-list-item]');
      if (items.length <= 1) {
        const input = items[0]?.querySelector('[data-list-value]');
        if (input) input.value = '';
        return;
      }
      remove.closest('[data-list-item]')?.remove();
      renumberList(list);
    });
    renumberList(list);
  }

  for (const select of document.querySelectorAll('[data-timezone-select]')) {
    const form = select.closest('form');
    const custom = form?.querySelector('[data-timezone-custom]');
    const customInput = form?.querySelector('[data-timezone-custom-input]');
    const syncTimeZoneChoice = () => {
      const useCustom = select.value === 'custom';
      if (custom) custom.open = useCustom;
      if (customInput) customInput.required = useCustom;
    };
    select.addEventListener('change', syncTimeZoneChoice);
    syncTimeZoneChoice();

    if (select.dataset.timezoneAutoDetect !== 'true' || select.value !== '') continue;

    let detected;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      detected = undefined;
    }
    if (!detected) continue;

    const isPreset = Array.from(select.options).some((option) => option.value === detected);
    select.value = isPreset ? detected : 'custom';
    if (!isPreset && customInput) customInput.value = detected;
    syncTimeZoneChoice();

    const source = form?.querySelector('[name="source"]');
    const status = form?.querySelector('[data-timezone-status]');
    if (source) source.value = 'detected';
    if (status) status.textContent = 'Detected from this device. Saving this as the initial time zone.';

    if (form && window.fetch && window.FormData) {
      const csrf = form.querySelector('[name="csrfToken"]')?.value;
      fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
        body: new URLSearchParams(new FormData(form)),
      }).then((response) => {
        if (!response.ok && status) {
          status.textContent = 'Detected for this visit. Save it manually if needed.';
        } else if (status) {
          status.textContent = 'Detected and saved as the initial time zone.';
        }
      }).catch(() => {
        if (status) status.textContent = 'Detected for this visit. Save it manually if needed.';
      });
    }
  }

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

  for (const grid of document.querySelectorAll('[data-usage-grid]')) {
    const cells = Array.from(grid.querySelectorAll('[data-usage-cell]'));
    const cellsByDay = new Map(cells.map((cell) => [Number(cell.dataset.usageIndex), cell]));
    const selected = cells.find((cell) => cell.getAttribute('aria-selected') === 'true');
    const recent = selected || cells.at(-1);
    if (recent && window.matchMedia?.('(max-width: 700px)').matches) {
      const scroll = grid.closest('.usage-calendar-scroll');
      if (scroll) scroll.scrollLeft = scroll.scrollWidth;
    }
    grid.addEventListener('keydown', (event) => {
      const current = event.target.closest?.('[data-usage-cell]');
      if (!current) return;
      const index = Number(current.dataset.usageIndex);
      const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
      const offset = offsets[event.key];
      if (offset !== undefined) {
        const next = cellsByDay.get(index + offset);
        if (!next) return;
        event.preventDefault();
        for (const cell of cells) cell.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        (selected || cells[0])?.focus();
      }
    });
  }
})();`;
