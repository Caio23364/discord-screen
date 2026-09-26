import { test, expect } from '@playwright/test';

test.describe('Discord Sandbox Simulator', () => {
  test.describe.configure({ mode: 'serial' });

  test('Activity carrega, mock do SDK funciona e restrição de captura aciona popup de fallback', async ({ page, context }) => {
    // Escuta logs do console para ajudar no debug do iframe
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

    // Navega para o simulador com instância dedicada
    const inst = `e2e-base-${Date.now()}`;
    await page.goto(`/sandbox.html?instance=${inst}`);

    // Acessa o iframe
    const frameLocator = page.frameLocator('#app-frame');

    // Verifica se a tela de carregamento some e a sala inicia
    // "Conectando..." (id="emptyTitle") some e "Pessoas na sala" (id="people") aparece
    await expect(frameLocator.locator('#emptyTitle')).toBeHidden({ timeout: 10000 });
    await expect(frameLocator.locator('#people')).toBeVisible();

    // Testa o botão de Share
    const pagePromise = context.waitForEvent('page');
    await frameLocator.locator('#share').click();

    // Aguarda a nova aba (popup)
    const newPage = await pagePromise;
    await newPage.waitForLoadState();
    
    // Verifica se a nova aba é a aba de transmissão externa (o fallback)
    expect(newPage.url()).toContain('/share.html');
    await newPage.close();
  });

  test('Aba de captura externa (/share.html) renderiza controles corretamente', async ({ page, context }) => {
    const inst = `e2e-share-${Date.now()}`;
    await page.goto(`/sandbox.html?instance=${inst}`);
    const frameLocator = page.frameLocator('#app-frame');
    await expect(frameLocator.locator('#emptyTitle')).toBeHidden({ timeout: 10000 });

    const pagePromise = context.waitForEvent('page');
    await frameLocator.locator('#share').click();
    const sharePage = await pagePromise;
    await sharePage.waitForLoadState();

    // Valida que os seletores de qualidade e quadros estão presentes
    await expect(sharePage.locator('#qualidade')).toBeVisible();
    await expect(sharePage.locator('#quadros')).toBeVisible();
    await expect(sharePage.locator('#tela-start')).toBeVisible();

    // Valida as opções de FPS disponíveis
    const quadros = sharePage.locator('#quadros');
    await expect(quadros.locator('option[value="30"]')).toBeAttached();
    await expect(quadros.locator('option[value="60"]')).toBeAttached();

    // Botão de iniciar não deve estar desabilitado (getDisplayMedia está mockado)
    await expect(sharePage.locator('#tela-start')).not.toBeDisabled();

    // Rodapé de instrução visível
    await expect(sharePage.locator('#tela-nota')).toBeVisible();

    await sharePage.close();
  });

  test('Interface da Activity exibe participantes e modal de configurações', async ({ page }) => {
    const inst = `e2e-ui-${Date.now()}`;
    await page.goto(`/sandbox.html?instance=${inst}`);
    const frameLocator = page.frameLocator('#app-frame');
    await expect(frameLocator.locator('#emptyTitle')).toBeHidden({ timeout: 10000 });

    // Verifica que o contador de pessoas está preenchido
    const peoplePill = frameLocator.locator('#people');
    await expect(peoplePill).toBeVisible();
    const text = await peoplePill.textContent();
    expect(text).toContain('Usuário Teste');
    expect(text).toContain('1');

    // Abre os ajustes da sala se o botão estiver visível para o dono
    const settingsBtn = frameLocator.locator('#roomSettings');
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      await expect(frameLocator.locator('#roomModal')).toBeVisible();
      await frameLocator.locator('#roomCancel').click();
      await expect(frameLocator.locator('#roomModal')).toBeHidden();
    }
  });

  test('Transmissão completa: inicia, conecta e renderiza via WebSocket', async ({ page, context, browser }) => {
    const inst = `e2e-stream-${Date.now()}`;
    
    // Escuta logs para entender por que o streaming não tá renderizando o tile
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    await page.goto(`/sandbox.html?instance=${inst}&uid=111`);
    const frameLocator = page.frameLocator('#app-frame');
    await expect(frameLocator.locator('#emptyTitle')).toBeHidden({ timeout: 10000 });

    // Abre a aba de captura (abre fora do iframe)
    const pagePromise = context.waitForEvent('page');
    await frameLocator.locator('#share').click();
    const sharePage = await pagePromise;
    sharePage.on('console', msg => console.log('SHARE LOG:', msg.text()));
    await sharePage.waitForLoadState();

    // Inicia a captura na aba do broadcaster
    await sharePage.locator('#tela-start').click();
    await expect(sharePage.locator('#tela-live')).toBeVisible({ timeout: 10000 });

    // Agora, usamos um espectador diferente para ver a transmissão (senão o botão de assistir some porque é "Sua transmissão")
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`/sandbox.html?instance=${inst}&uid=222`);
    const viewerFrame = viewerPage.frameLocator('#app-frame');
    await expect(viewerFrame.locator('#emptyTitle')).toBeHidden({ timeout: 10000 });

    // No espectador, aguarda o tile da transmissão aparecer com o botão de assistir
    const tile = viewerFrame.locator('.tile.sharing').first();
    await expect(tile).toBeVisible({ timeout: 10000 });

    // Clica para assistir (o botão de Play)
    await tile.locator('.watch-prompt button').click();

    // Aguarda o canvas de renderização aparecer dentro do tile
    await expect(tile.locator('canvas')).toBeVisible({ timeout: 15000 });
    
    // Verifica que o loader sumiu
    await expect(tile.locator('.tile-loading')).toBeHidden();

    // Na aba de captura, valida que está de fato enviando bytes (bitrate atualiza)
    await expect(sharePage.locator('#tela-bitrate')).not.toHaveText('—', { timeout: 10000 });
    
    await sharePage.close();
  });
});
