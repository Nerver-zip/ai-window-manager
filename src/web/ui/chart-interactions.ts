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
      if (form?.requestSubmit) form.requestSubmit();
    });
  }

  for (const form of document.querySelectorAll('[data-provider-picker-auto-submit]')) {
    for (const input of form.querySelectorAll('.provider-picker-input')) {
      input.addEventListener('change', () => {
        if (form?.requestSubmit) form.requestSubmit();
      });
    }
  }

  for (const form of document.querySelectorAll('[data-usage-filter-auto-submit]')) {
    form.addEventListener('change', (event) => {
      const target = event.target;
      if (target?.matches?.('select[name="window"]')) {
        if (form?.requestSubmit) form.requestSubmit();
        else form?.submit?.();
      }
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
    const choices = Array.from(form.querySelectorAll('[name="policyKind"]'));
    const sections = Array.from(form.querySelectorAll('[data-policy-fields]'));
    if (choices.length === 0) continue;

    const syncPolicyFields = () => {
      const selected = form.querySelector('[name="policyKind"]:checked')?.value;
      for (const choice of form.querySelectorAll('[data-policy-choice]')) {
        choice.classList.toggle('is-selected', choice.querySelector('input')?.checked === true);
      }
      for (const section of sections) {
        setPolicyFieldState(section, section.dataset.policyFields === selected);
      }
    };

    for (const choice of choices) choice.addEventListener('change', syncPolicyFields);
    syncPolicyFields();

    let previewTimer;
    let previewController;
    const refreshPreview = () => {
      const root = form.parentElement?.parentElement;
      const target = root?.querySelector('[data-schedule-horizon]');
      const status = root?.querySelector('[data-preview-status]');
      if (!target) return;
      clearTimeout(previewTimer);
      previewController?.abort();
      if (status) status.textContent = 'Updating the schedule preview.';
      target.setAttribute('aria-busy', 'true');
      previewTimer = setTimeout(async () => {
        const controller = new AbortController();
        previewController = controller;
        const query = new URLSearchParams(new FormData(form));
        query.delete('csrfToken');
        try {
          const response = await fetch('/schedule/preview?' + query.toString(), {
            credentials: 'same-origin', signal: controller.signal,
            headers: { Accept: 'text/html' },
          });
          if (!response.ok) {
            if (status) status.textContent = 'Preview could not be updated. Your saved schedule is unchanged.';
            return;
          }
          target.innerHTML = await response.text();
          if (status) status.textContent = 'Schedule preview updated.';
        } catch (error) {
          if (error?.name !== 'AbortError' && status) {
            status.textContent = 'Preview could not be updated. Your saved schedule is unchanged.';
          }
        } finally {
          if (previewController === controller) target.removeAttribute('aria-busy');
        }
      }, 250);
    };
    form.addEventListener('input', refreshPreview);
    form.addEventListener('change', refreshPreview);
    form.addEventListener('click', (event) => {
      const p = event.target.closest?.('[data-anchor-preset]');
      if (p) {
        const input = form.querySelector('[name="anchorLocalTime"]');
        if (input) { input.value = p.dataset.anchorPreset; input.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      const s = event.target.closest?.('[data-time-step]');
      if (s) {
        const delta = parseInt(s.dataset.timeStep, 10);
        const input = (s.closest('.time-input-group') || s.closest('.dynamic-list-item') || form).querySelector('input[type="time"]');
        if (input) {
          const [h, m] = (input.value || '08:00').split(':').map(Number);
          if (!isNaN(h) && !isNaN(m)) {
            const tot = ((h * 60 + m + delta) % 1440 + 1440) % 1440;
            input.value = String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
    });
  }

  function renumberList(list) {
    for (const [index, item] of Array.from(list.querySelectorAll('[data-list-item]')).entries()) {
      if (list.dataset.listKind === 'period') {
        const start = item.querySelector('[data-period-start]');
        const end = item.querySelector('[data-period-end]');
        const labels = item.querySelectorAll('label');
        if (start) { start.id = list.id + '-start-' + index; labels[0].htmlFor = start.id; }
        if (end) { end.id = list.id + '-end-' + index; labels[1].htmlFor = end.id; }
        item.querySelector('[data-list-remove]')?.setAttribute('aria-label', 'Remove active-hours period ' + (index + 1));
      } else {
        const label = item.querySelector('label');
        const input = item.querySelector('[data-list-value]');
        if (!label || !input) continue;
        const id = list.id + '-' + index;
        label.htmlFor = id;
        label.firstChild.textContent = 'Time ' + (index + 1);
        input.id = id;
      }
    }
  }

  function addScheduleItem(list, values = []) {
    const item = document.createElement('div');
    item.className = 'dynamic-list-item' + (list.dataset.listKind === 'period' ? ' active-period-item' : ' time-chip');
    item.dataset.listItem = 'true';
    if (list.dataset.listKind === 'period') {
      for (const [index, labelText] of ['From', 'To'].entries()) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.name = index === 0 ? 'periodStarts' : 'periodEnds';
        input.type = 'time'; input.required = true;
        input.dataset[index === 0 ? 'periodStart' : 'periodEnd'] = 'true';
        input.value = values[index] || '';
        label.append(document.createTextNode(labelText), input);
        item.append(label);
      }
    } else {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.name = list.dataset.listName || ''; input.type = 'time';
      input.required = true; input.dataset.listValue = 'true';
      label.append(document.createTextNode(''), input); item.append(label);
    }
    const remove = document.createElement('button');
    remove.className = 'button button-secondary dynamic-list-remove';
    remove.type = 'button'; remove.dataset.listRemove = 'true'; remove.textContent = 'Remove';
    item.append(remove);
    const actions = list.querySelector('.dynamic-list-actions');
    list.insertBefore(item, actions || list.querySelector('[data-list-add]'));
    renumberList(list);
    return item;
  }

  for (const list of document.querySelectorAll('[data-schedule-list]')) {
    const add = list.querySelector('[data-list-add]');
    add?.addEventListener('click', () => {
      const item = addScheduleItem(list);
      item.querySelector('input')?.focus();
    });
    list.addEventListener('click', (event) => {
      const timePreset = event.target.closest?.('[data-time-preset]');
      const periodPreset = event.target.closest?.('[data-period-preset-start]');
      if (timePreset && list.dataset.listKind === 'time') {
        const value = timePreset.dataset.timePreset;
        const inputs = Array.from(list.querySelectorAll('[data-list-value]'));
        if (!inputs.some((input) => input.value === value)) {
          let target = inputs.find((input) => !input.value);
          if (!target) target = addScheduleItem(list).querySelector('[data-list-value]');
          if (target) { target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }
      if (periodPreset && list.dataset.listKind === 'period') {
        const startValue = periodPreset.dataset.periodPresetStart;
        const endValue = periodPreset.dataset.periodPresetEnd;
        const item = list.querySelector('[data-list-item]') || addScheduleItem(list);
        const start = item.querySelector('[data-period-start]');
        const end = item.querySelector('[data-period-end]');
        if (start && end) {
          start.value = startValue;
          end.value = endValue;
          start.dispatchEvent(new Event('input', { bubbles: true }));
          end.dispatchEvent(new Event('input', { bubbles: true }));
          start.focus();
        }
      }
    });
    list.addEventListener('click', (event) => {
      const remove = event.target.closest?.('[data-list-remove]');
      if (!remove) return;
      const items = list.querySelectorAll('[data-list-item]');
      if (items.length <= 1) {
        for (const input of items[0]?.querySelectorAll('input') || []) input.value = '';
        return;
      }
      remove.closest('[data-list-item]')?.remove();
      renumberList(list);
    });
    renumberList(list);
  }

  for (const select of document.querySelectorAll('[data-timezone-select]')) {
    const form = select.closest('form');
    const source = form?.querySelector('[name="source"]');
    const status = form?.querySelector('[data-timezone-status]');
    select.addEventListener('change', () => {
      if (source) source.value = 'manual';
      if (status) status.textContent = '';
    });

    if (select.dataset.timezoneAutoDetect !== 'true' || select.value !== '') continue;

    let detected;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      detected = undefined;
    }
    if (!detected) continue;

    let option = Array.from(select.options).find((candidate) => candidate.value === detected);
    if (!option) {
      let group = select.querySelector('optgroup[data-detected-timezone]');
      if (!group) {
        group = document.createElement('optgroup');
        group.label = 'Detected from this device';
        group.dataset.detectedTimezone = 'true';
        select.append(group);
      }
      option = document.createElement('option');
      option.value = detected;
      const city = detected.split('/').at(-1)?.replaceAll('_', ' ') || detected;
      let offset = '';
      try {
        offset = Intl.DateTimeFormat('en', { timeZone: detected, timeZoneName: 'shortOffset' })
          .formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value || '';
      } catch {
        offset = '';
      }
      option.textContent = city + (offset ? ' (' + offset.replace(/^GMT/, 'UTC') + ')' : '');
      group.append(option);
    }
    select.value = detected;
    if (source) source.value = 'detected';
    if (status) status.textContent = 'Detected from your browser. Save to use this time zone.';
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
      row.innerHTML = '<span class="chart-tooltip-indicator chart-series-' + (item.dataset.chartSeriesIndex || '1') + '" aria-hidden="true"></span><span class="chart-tooltip-label">' + (item.dataset.chartSeries || 'Value') + '</span><strong class="chart-tooltip-value">' + (item.dataset.chartValue || 'Not available') + '</strong>';
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
