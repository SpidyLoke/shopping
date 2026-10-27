// Accordion: one slice open at a time (hover or tap on wide screens).
const slices = [...document.querySelectorAll('.slice')];
function openSlice(slice) {
  for (const s of slices) {
    const on = s === slice;
    s.classList.toggle('is-open', on);
    s.setAttribute('aria-expanded', String(on));
  }
}
for (const s of slices) {
  s.addEventListener('click', () => openSlice(s));
  s.addEventListener('focus', () => openSlice(s));
  s.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse') openSlice(s);
  });
}

// Split the scrub paragraph into words so each can light up in turn.
const scrub = document.querySelector('.scrub');
scrub.innerHTML = scrub.textContent.trim().split(/\s+/).map((w) => `<span class="w">${w}</span>`).join(' ');

if (window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);
  const mm = gsap.matchMedia();

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // Words go from dim to full as the paragraph crosses the screen.
    gsap.to('.scrub .w', {
      opacity: 1,
      stagger: 0.1,
      ease: 'none',
      scrollTrigger: { trigger: '.scrub', start: 'top 80%', end: 'bottom 40%', scrub: true },
    });

    // Images grow in as they arrive, then dim as they leave.
    for (const img of document.querySelectorAll('.reveal-img')) {
      gsap.fromTo(img, { scale: 0.8, opacity: 0.4 }, {
        scale: 1,
        opacity: 1,
        ease: 'none',
        scrollTrigger: { trigger: img, start: 'top 95%', end: 'top 55%', scrub: true },
      });
      gsap.to(img, {
        opacity: 0.2,
        ease: 'none',
        immediateRender: false,
        scrollTrigger: { trigger: img, start: 'bottom 30%', end: 'bottom top', scrub: true },
      });
    }

    // Hero settles in on load.
    gsap.from('.hero h1, .lede, .hero-ctas', { y: 40, opacity: 0, duration: 1.1, stagger: 0.12, ease: 'expo.out' });
  });
}
