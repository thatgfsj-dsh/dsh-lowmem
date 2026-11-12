    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: TEXT, en: TEXT_EN }), 'lowmem: 词典')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-lowmem',
          order: 70,
          locale: NS,
          label: () => t('settings.title'),
        }, props => h(LowmemSection, { ...props, t })))
      },
    }
