/**
 * dsh-ponytail-caveman — Client half (plugin detail page config section).
 * Registers a "plugins.item" occupant so the plugin's own detail page in
 * Settings → 内置插件 renders a config panel: two mode selects and two
 * optional custom-rules textareas, persisted through the Host half's
 * /api/dsh-ponytail-caveman/config route (config editor write-back).
 *
 * Note: slot occupants receive business props only ({ view, form }) — no
 * ctx — so the component takes ctx through this factory's closure.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ponytail-caveman',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const LEVELS = ['off', 'lite', 'full', 'ultra'];
    const ROUTE = '/api/dsh-ponytail-caveman/config';
    const PACKAGE_ID = '@local/dsh-ponytail-caveman';

    const DICTS = {
      en: {
        intro: 'Working-style prompts injected into every session: ponytail keeps changes minimal, caveman makes replies terse. Both reach the system prompt and a visible message at each session start.',
        ponytail: 'Ponytail mode (lazy senior dev)',
        caveman: 'Caveman mode (terse output)',
        off: 'Off', lite: 'Lite', full: 'Full', ultra: 'Ultra',
        ponytailText: 'Ponytail rules (optional)',
        cavemanText: 'Caveman rules (optional)',
        textPlaceholder: 'Leave empty to use the built-in rules of the selected level.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved — new sessions get the visible injection immediately; open sessions receive the system-prompt update at once.',
        loadError: 'Could not load the current configuration.',
        offHint: 'Both modes are off: nothing is injected.',
        summary: 'Ponytail and caveman working styles, configurable on the plugin page.',
      },
      zh: {
        intro: '注入到每个会话的工作风格提示：ponytail 让改动尽量少，caveman 让回复尽量短。两者同时写入系统提示词和每次会话开头的可见消息。',
        ponytail: 'Ponytail 模式（懒高级开发）',
        caveman: 'Caveman 模式（极简输出）',
        off: '关闭', lite: '轻量', full: '完整', ultra: '极致',
        ponytailText: 'Ponytail 规则（可选）',
        cavemanText: 'Caveman 规则（可选）',
        textPlaceholder: '留空使用所选等级的内置规则文本。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存——新会话立即出现可见注入；已开会话的系统提示词即时更新。',
        loadError: '无法加载当前配置。',
        offHint: '两个模式都关闭：不注入任何内容。',
        summary: 'Ponytail 与 caveman 工作风格，可在插件页配置。',
      },
    };

    const css = `
.dpc-page{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);}
.dpc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
.dpc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dpc-label{font-size:13px;font-weight:600;}
.dpc-select{min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font-size:13px;}
.dpc-text{width:100%;box-sizing:border-box;min-height:110px;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font-size:12px;line-height:1.5;resize:vertical;font-family:inherit;}
.dpc-text:focus,.dpc-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dpc-intro{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:0;}
.dpc-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0;}
.dpc-save{align-self:flex-start;padding:7px 18px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:13px;font-weight:600;cursor:pointer;}
.dpc-save:disabled{opacity:.6;cursor:default;}
.dpc-status{font-size:12px;color:var(--dsw-alias-state-success-primary);white-space:pre-wrap;}
.dpc-error{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;}
`;

    function ConfigPanel({ view, ctx }) {
      const [, setTick] = React.useState(0);
      const rawLocale = ctx.locale?.getSnapshot?.().locale ?? 'en';
      const lang = String(rawLocale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      const t = (key) => DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
      React.useEffect(() => ctx.locale?.subscribe?.(() => setTick((n) => n + 1)), []);

      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState('');
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        if (view !== 'page') return;
        let cancelled = false;
        (async () => {
          try {
            const res = await fetch(`${location.origin}${ROUTE}`);
            const value = await res.json();
            if (!res.ok) throw new Error(value?.error || `HTTP ${res.status}`);
            if (!cancelled) setForm({ ponytail: value.ponytail ?? 'off', caveman: value.caveman ?? 'off', ponytailText: value.ponytailText ?? '', cavemanText: value.cavemanText ?? '' });
          } catch {
            if (!cancelled) setError(t('loadError'));
          }
        })();
        return () => { cancelled = true; };
      }, [view]);

      if (view !== 'page') return null; // the card/detail-description "summary" view contributes nothing

      const set = (key) => (event) => {
        const value = event.target.value;
        setForm((current) => ({ ...current, [key]: value }));
        setStatus('');
      };

      const save = async () => {
        setBusy(true); setError(''); setStatus('');
        try {
          const res = await fetch(`${location.origin}${ROUTE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ponytail: form.ponytail,
              caveman: form.caveman,
              ponytailText: form.ponytailText,
              cavemanText: form.cavemanText,
            }),
          });
          const value = await res.json();
          if (!res.ok) throw new Error(value?.error || `HTTP ${res.status}`);
          setStatus(t('saved'));
        } catch (saveError) {
          setError(String(saveError?.message ?? saveError));
        } finally {
          setBusy(false);
        }
      };

      const levelOption = (level) => h('option', { key: level, value: level }, t(level));

      return h('div', { className: 'dpc-page' },
        h('p', { className: 'dpc-intro' }, t('intro')),
        form === null && error === ''
          ? null
          : error !== '' && form === null
            ? h('p', { className: 'dpc-error' }, error)
            : h(React.Fragment, null,
                h('div', { className: 'dpc-card' },
                  h('div', { className: 'dpc-row' },
                    h('label', { className: 'dpc-label', htmlFor: 'dpc-ponytail' }, t('ponytail')),
                    h('select', { id: 'dpc-ponytail', className: 'dpc-select', value: form.ponytail, onChange: set('ponytail') }, LEVELS.map(levelOption)),
                  ),
                  h('div', { className: 'dpc-row' },
                    h('label', { className: 'dpc-label', htmlFor: 'dpc-caveman' }, t('caveman')),
                    h('select', { id: 'dpc-caveman', className: 'dpc-select', value: form.caveman, onChange: set('caveman') }, LEVELS.map(levelOption)),
                  ),
                  form.ponytail === 'off' && form.caveman === 'off' ? h('p', { className: 'dpc-hint' }, t('offHint')) : null,
                ),
                h('div', { className: 'dpc-card' },
                  h('label', { className: 'dpc-label', htmlFor: 'dpc-ponytail-text' }, t('ponytailText')),
                  h('textarea', { id: 'dpc-ponytail-text', className: 'dpc-text', value: form.ponytailText, onChange: set('ponytailText'), placeholder: t('textPlaceholder'), spellCheck: false }),
                  h('label', { className: 'dpc-label', htmlFor: 'dpc-caveman-text' }, t('cavemanText')),
                  h('textarea', { id: 'dpc-caveman-text', className: 'dpc-text', value: form.cavemanText, onChange: set('cavemanText'), placeholder: t('textPlaceholder'), spellCheck: false }),
                ),
                h('div', { className: 'dpc-row' },
                  h('button', { className: 'dpc-save', onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
                  h('span', { className: 'dpc-status', 'aria-live': 'polite' }, status),
                ),
                error !== '' ? h('p', { className: 'dpc-error' }, error) : null,
              ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let disposeStyles;
        try {
          const styles = require('styles');
          disposeStyles = styles.insert(css);
        } catch {
          const el = document.createElement('style');
          el.dataset.dpc = 'dsh-ponytail-caveman';
          el.textContent = css;
          document.head.append(el);
          disposeStyles = () => el.remove();
        }
        const offEn = ctx.locale?.register?.('dshPonytailCaveman', 'en', DICTS.en);
        const offZh = ctx.locale?.register?.('dshPonytailCaveman', 'zh', DICTS.zh);
        // The plugin manager page filters this list slot with `only: item.id`; bundle items are keyed by package name.
        const disposeItem = ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            { name: 'plugins.item', id: PACKAGE_ID, order: 10, label: () => DICTS[(String(ctx.locale?.getSnapshot?.().locale ?? 'en')).toLowerCase().startsWith('zh') ? 'zh' : 'en'].summary },
            (props) => ConfigPanel({ ...props, ctx }),
          ));
        return () => {
          disposeItem?.();
          offZh?.(); offEn?.();
          disposeStyles?.();
        };
      },
    };
  },
});
