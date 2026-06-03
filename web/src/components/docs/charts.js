const chartFont = { family: '"IBM Plex Mono", ui-monospace, monospace', size: 10 };
    const gridColor = 'rgba(255,255,255,0.05)';
    const tickColor = '#62626b';
    Chart.defaults.color = tickColor;
    Chart.defaults.borderColor = gridColor;

    // Success rate bar chart
    new Chart(document.getElementById('chart-success'), {
      type: 'bar',
      data: {
        labels: ['claude-sonnet-4', 'claude-haiku-4-5', 'gemini-2.0-flash', 'gpt-4.1-mini', 'gpt-4.1-nano', 'llama-3.1-8b', 'ministral-8b'],
        datasets: [
          { label: 'prompt v1 · no tools', data: [80, 67, 58, 60, 53, 47, 40], backgroundColor: '#fb7185', borderRadius: 4 },
          { label: 'prompt v2 · with tools', data: [100, 93, 93, 87, 80, 73, 60], backgroundColor: '#bef264', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#a0a0a8', font: chartFont, boxWidth: 10, padding: 14 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%' } }
        },
        scales: {
          x: { ticks: { color: tickColor, font: chartFont }, grid: { color: gridColor } },
          y: { min: 0, max: 100, ticks: { color: tickColor, font: chartFont, callback: v => v + '%' }, grid: { color: gridColor } }
        }
      }
    });

    // Scatter: accuracy vs speed
    new Chart(document.getElementById('chart-scatter'), {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'claude-sonnet-4', data: [{ x: 6.5, y: 100 }, { x: 9.8, y: 80 }], backgroundColor: '#bef264', borderColor: '#d9f99d', pointRadius: 7, pointHoverRadius: 10 },
          { label: 'claude-haiku-4-5', data: [{ x: 3.5, y: 93 }, { x: 5.2, y: 67 }], backgroundColor: '#7dd3fc', borderColor: '#bae6fd', pointRadius: 7, pointHoverRadius: 10 },
          { label: 'gemini-2.0-flash', data: [{ x: 0.9, y: 93 }, { x: 1.4, y: 58 }], backgroundColor: '#d8b4fe', borderColor: '#e9d5ff', pointRadius: 7, pointHoverRadius: 10 },
          { label: 'gpt-4.1-mini', data: [{ x: 1.5, y: 87 }, { x: 2.0, y: 60 }], backgroundColor: '#fcd34d', borderColor: '#fde68a', pointRadius: 7, pointHoverRadius: 10 },
          { label: 'gpt-4.1-nano', data: [{ x: 1.2, y: 80 }, { x: 1.8, y: 53 }], backgroundColor: '#fdba74', borderColor: '#fed7aa', pointRadius: 7, pointHoverRadius: 10 },
          { label: 'llama-3.1-8b', data: [{ x: 0.6, y: 73 }, { x: 0.9, y: 47 }], backgroundColor: '#fb7185', borderColor: '#fda4af', pointRadius: 7, pointHoverRadius: 10 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#a0a0a8', font: chartFont, boxWidth: 10, padding: 10 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '% at ' + ctx.parsed.x.toFixed(1) + 's/case' } }
        },
        scales: {
          x: { title: { display: true, text: 'avg seconds / case', color: tickColor, font: chartFont }, ticks: { color: tickColor, font: chartFont }, grid: { color: gridColor } },
          y: { min: 30, max: 105, title: { display: true, text: 'accuracy %', color: tickColor, font: chartFont }, ticks: { color: tickColor, font: chartFont, callback: v => v + '%' }, grid: { color: gridColor } }
        }
      }
    });

    // Token usage horizontal bar
    new Chart(document.getElementById('chart-tokens'), {
      type: 'bar',
      data: {
        labels: ['claude-sonnet-4', 'claude-haiku-4-5', 'gpt-4.1-mini', 'llama-3.1-8b', 'ministral-8b', 'gpt-4.1-nano', 'gemini-2.0-flash'],
        datasets: [
          { label: 'input tokens', data: [1102, 921, 782, 641, 432, 305, 281], backgroundColor: '#d8b4fe', borderRadius: 3 },
          { label: 'output tokens', data: [145, 133, 109, 107, 104, 63, 54], backgroundColor: '#7dd3fc', borderRadius: 3 }
        ]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a0a0a8', font: chartFont, boxWidth: 10, padding: 14 } } },
        scales: {
          x: { stacked: true, ticks: { color: tickColor, font: chartFont }, grid: { color: gridColor } },
          y: { stacked: true, ticks: { color: tickColor, font: chartFont }, grid: { color: 'transparent' } }
        }
      }
    });

    // Prompt evolution line chart
    new Chart(document.getElementById('chart-evolution'), {
      type: 'line',
      data: {
        labels: ['v1 (minimal)', 'v2 (scoped)', 'v3 (+ tools)', 'v4 (refined)'],
        datasets: [
          { label: 'claude-sonnet-4', data: [80, 87, 93, 100], borderColor: '#bef264', backgroundColor: 'rgba(190,242,100,0.12)', tension: 0.3, fill: true, pointRadius: 5 },
          { label: 'gpt-4.1-mini', data: [60, 73, 80, 87], borderColor: '#fcd34d', backgroundColor: 'rgba(252,211,77,0.08)', tension: 0.3, fill: true, pointRadius: 5 },
          { label: 'gemini-2.0-flash', data: [58, 67, 80, 93], borderColor: '#d8b4fe', backgroundColor: 'rgba(216,180,254,0.08)', tension: 0.3, fill: true, pointRadius: 5 },
          { label: 'llama-3.1-8b', data: [47, 53, 60, 73], borderColor: '#fb7185', backgroundColor: 'rgba(251,113,133,0.08)', tension: 0.3, fill: true, pointRadius: 5 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#a0a0a8', font: chartFont, boxWidth: 10, padding: 10 } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%' } }
        },
        scales: {
          x: { ticks: { color: tickColor, font: chartFont }, grid: { color: gridColor } },
          y: { min: 30, max: 105, ticks: { color: tickColor, font: chartFont, callback: v => v + '%' }, grid: { color: gridColor } }
        }
      }
    });

    // Scroll reveal observer
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
