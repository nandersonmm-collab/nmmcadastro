// TRIVA Capacita — aulas concluídas, testes sorteados, correção no servidor e certificados.
// O profissional usa o mesmo token de sessão do Portal do Profissional (tabela candidato_sessions).
// O gabarito nunca é enviado ao navegador antes da correção.
//
// Dois tipos de curso:
//  - com página própria (capacita_cursos.pagina, ex.: atendimento.html): módulos fixos na página,
//    perguntas em capacita_banco (1ª opção = correta), teste por módulo + avaliação final;
//  - montados no painel (aulas em capacita_aulas, perguntas em capacita_questoes): aulas concluídas
//    ficam registradas aqui e os exercícios finais são sorteados e corrigidos aqui.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Regras das avaliações
const MOD_QTD = 3, MOD_MIN = 2;            // teste de módulo (cursos com página): 3 perguntas, mínimo 2
const FINAL_QTD = 20, APROVACAO = 0.7;      // avaliação final: 20 perguntas (página) / sorteio do painel; mínimo 70%
const VALIDADE_TENTATIVA_MIN = 180;         // um teste sorteado vale por 3 horas
// cursos do painel: até 5 perguntas usa todas; acima disso sorteia 2/3 (mínimo 5)
const qtdSorteio = (total: number) => (total <= 5 ? total : Math.max(5, Math.round(total * 2 / 3)));

type Q = { id: string; modulo: number | null; pergunta: string; opcoes: string[]; correta: number; explicacao: string | null };
type Curso = { id: string; slug: string; titulo: string; carga_horaria: string | null; modulos_total: number | null; pagina: string | null; publicado: boolean };

function rnd(n: number) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle<T>(arr: T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// prefere questões que não saíram na última tentativa
function sortear<T extends { id: string }>(pool: T[], n: number, evitar: string[]): T[] {
  const novas = shuffle(pool.filter((q) => !evitar.includes(q.id)));
  const repetidas = shuffle(pool.filter((q) => evitar.includes(q.id)));
  return [...novas, ...repetidas].slice(0, n);
}
function codigo() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = "";
  for (let i = 0; i < 8; i++) s += A[rnd(A.length)];
  return "TC-" + s.slice(0, 4) + "-" + s.slice(4);
}
function nomeBonito(n: string) {
  return (n || "").trim().replace(/\s+/g, " ").toLowerCase().split(" ")
    .map((w) => /^(da|de|do|das|dos|e)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function cpfMask(c: string) {
  const d = (c || "").replace(/\D/g, "");
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : "";
}
const primeiro = (s: string) => (s || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)[0] || "";

async function candidatoPorToken(token: string) {
  if (!token) return null;
  const { data: s } = await sb.from("candidato_sessions").select("candidato_id,expires_at").eq("token", token).maybeSingle();
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  const { data: c } = await sb.from("candidatos")
    .select("id,nome_completo,cpf,cidades_atuacao,funcoes_experiencia,status").eq("id", s.candidato_id).maybeSingle();
  return c;
}
async function curso(slug: string): Promise<Curso | null> {
  if (!slug) return null;
  const { data } = await sb.from("capacita_cursos").select("id,slug,titulo,carga_horaria,modulos_total,pagina,publicado").eq("slug", slug).maybeSingle();
  return data && data.publicado ? data as Curso : null;
}
// perguntas do curso no mesmo formato, venham do banco da página ou do painel
async function perguntas(c: Curso, ids?: string[]): Promise<Q[]> {
  if (c.pagina) {
    let q = sb.from("capacita_banco").select("id,modulo,pergunta,opcoes,explicacao").eq("curso_slug", c.slug);
    q = ids ? q.in("id", ids) : q.eq("ativo", true);
    const { data } = await q;
    return (data || []).map((x: any) => ({ ...x, correta: 0 }));
  }
  let q = sb.from("capacita_questoes").select("id,pergunta,opcoes,correta,explicacao").eq("curso_id", c.id);
  if (ids) q = q.in("id", ids);
  const { data } = await q;
  return (data || []).filter((x: any) => Array.isArray(x.opcoes) && x.opcoes.length >= 2)
    .map((x: any) => ({ ...x, modulo: null, correta: Math.min(Math.max(0, x.correta || 0), x.opcoes.length - 1) }));
}
async function aulasDoCurso(c: Curso) {
  if (c.pagina) return [];
  const { data } = await sb.from("capacita_aulas").select("id").eq("curso_id", c.id);
  return (data || []).map((a) => a.id as string);
}
function certPublico(c: any) {
  return {
    codigo: c.codigo, nome: c.nome, cpf: cpfMask(c.cpf), funcao: c.funcao, cidade: c.cidade,
    curso_titulo: c.curso_titulo, carga_horaria: c.carga_horaria,
    acertos: c.acertos, total: c.total, nota: c.nota, tentativa: c.tentativa, emitido_em: c.emitido_em,
  };
}
async function progresso(candId: string, c: Curso) {
  const [t, cert, feitas] = await Promise.all([
    sb.from("capacita_tentativas").select("tipo,modulo,aprovado,acertos,total,corrigido_em")
      .eq("candidato_id", candId).eq("curso_slug", c.slug).not("corrigido_em", "is", null).order("corrigido_em", { ascending: false }),
    sb.from("capacita_certificados").select("*").eq("candidato_id", candId).eq("curso_slug", c.slug).maybeSingle(),
    c.pagina ? Promise.resolve({ data: [] as any[] }) :
      sb.from("capacita_aulas_feitas").select("aula_id").eq("candidato_id", candId).eq("curso_slug", c.slug),
  ]);
  const rows = t.data || [];
  const finais = rows.filter((r) => r.tipo === "final");
  const out: Record<string, unknown> = {
    final_tentativas: finais.length,
    ultima_final: finais[0] ? { acertos: finais[0].acertos, total: finais[0].total, aprovado: finais[0].aprovado } : null,
    certificado: cert.data ? certPublico(cert.data) : null,
  };
  if (c.pagina) {
    out.modulos_ok = [...new Set(rows.filter((r) => r.tipo === "modulo" && r.aprovado).map((r) => Number(r.modulo)))].sort((a: number, b: number) => a - b);
  } else {
    out.aulas_feitas = (feitas.data || []).map((x: any) => x.aula_id);
    const total = (await perguntas(c)).length;
    out.questoes = total; out.sorteio = qtdSorteio(total);
  }
  return out;
}
async function emitirCertificado(cand: any, c: Curso, acertos: number, total: number) {
  const { data: existente } = await sb.from("capacita_certificados").select("*").eq("candidato_id", cand.id).eq("curso_slug", c.slug).maybeSingle();
  if (existente) return existente;
  const { count } = await sb.from("capacita_tentativas").select("id", { count: "exact", head: true })
    .eq("candidato_id", cand.id).eq("curso_slug", c.slug).eq("tipo", "final").not("corrigido_em", "is", null);
  for (let i = 0; i < 5; i++) {
    const { data, error } = await sb.from("capacita_certificados").insert({
      codigo: codigo(), candidato_id: cand.id, curso_slug: c.slug,
      curso_titulo: c.titulo, carga_horaria: c.carga_horaria || null,
      nome: nomeBonito(cand.nome_completo), cpf: (cand.cpf || "").replace(/\D/g, ""),
      funcao: primeiro(cand.funcoes_experiencia), cidade: primeiro(cand.cidades_atuacao),
      acertos, total, nota: total ? Math.round(acertos / total * 100) : 100, tentativa: count || 1,
    }).select("*").single();
    if (!error) return data;
    if (!/duplicate|unique/i.test(error.message)) throw error;
    if (/candidato_id/.test(error.message)) {
      const { data: ja } = await sb.from("capacita_certificados").select("*").eq("candidato_id", cand.id).eq("curso_slug", c.slug).single();
      return ja;
    }
  }
  throw new Error("Não foi possível gerar o código do certificado.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let body: any;
  try { body = await req.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const acao = body?.acao;

  try {
    // Validação pública do certificado (sem login)
    if (acao === "validar") {
      const cod = String(body.codigo || "").trim().toUpperCase();
      if (!/^TC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cod)) return json({ valido: false });
      const { data } = await sb.from("capacita_certificados").select("*").eq("codigo", cod).maybeSingle();
      if (!data) return json({ valido: false });
      const p = certPublico(data);
      return json({ valido: true, certificado: { codigo: p.codigo, nome: p.nome, cpf: p.cpf, curso_titulo: p.curso_titulo, carga_horaria: p.carga_horaria, nota: p.nota, emitido_em: p.emitido_em } });
    }

    const cand = await candidatoPorToken(body.token);
    if (!cand) return json({ erro: "Sessão expirada. Entre novamente." }, 401);

    // Perfil + progresso em todos os cursos publicados
    if (acao === "resumo") {
      const { data: cursos } = await sb.from("capacita_cursos").select("id,slug,titulo,carga_horaria,modulos_total,pagina,publicado").eq("publicado", true);
      const out: Record<string, unknown> = {};
      for (const c of (cursos || []) as Curso[]) out[c.slug] = await progresso(cand.id, c);
      return json({
        ok: true,
        perfil: { nome: nomeBonito(cand.nome_completo), cpf: cpfMask(cand.cpf), cidade: primeiro(cand.cidades_atuacao), funcao: primeiro(cand.funcoes_experiencia) },
        cursos: out,
      });
    }

    // Registra aulas concluídas (cursos do painel). Curso sem exercícios: certificado ao concluir todas.
    if (acao === "aula") {
      const c = await curso(body.curso);
      if (!c || c.pagina) return json({ erro: "Curso não encontrado." }, 404);
      const doCurso = await aulasDoCurso(c);
      const ids: string[] = (Array.isArray(body.aulas) ? body.aulas : [body.aula]).map(String).filter((id: string) => doCurso.includes(id));
      if (ids.length) {
        const { error } = await sb.from("capacita_aulas_feitas").upsert(
          ids.map((aula_id) => ({ candidato_id: cand.id, aula_id, curso_slug: c.slug })),
          { onConflict: "candidato_id,aula_id", ignoreDuplicates: true });
        if (error) throw error;
      }
      const prog = await progresso(cand.id, c) as any;
      const todas = doCurso.length > 0 && doCurso.every((id) => prog.aulas_feitas.includes(id));
      if (todas && prog.questoes === 0 && !prog.certificado) prog.certificado = certPublico(await emitirCertificado(cand, c, 0, 0));
      return json({ ok: true, progresso: prog });
    }

    if (acao === "sortear") {
      const c = await curso(body.curso);
      if (!c) return json({ erro: "Curso não encontrado." }, 404);
      const tipo = c.pagina && body.tipo !== "final" ? "modulo" : "final";
      const prog = await progresso(cand.id, c) as any;
      const pool = await perguntas(c);
      let escolhidas: Q[] = [];
      let modulo: number | null = null;

      // última tentativa do mesmo tipo, para não repetir perguntas
      let q = sb.from("capacita_tentativas").select("questoes").eq("candidato_id", cand.id).eq("curso_slug", c.slug).eq("tipo", tipo);
      if (tipo === "modulo") { modulo = Number(body.modulo); q = q.eq("modulo", modulo); }
      const { data: ult } = await q.order("criado_em", { ascending: false }).limit(1);
      const evitar: string[] = ult && ult[0] ? (ult[0].questoes as any[]).map((x) => x.id) : [];

      if (tipo === "modulo") {
        if (!(modulo! >= 1 && modulo! <= (c.modulos_total || 0))) return json({ erro: "Módulo inválido." }, 400);
        escolhidas = sortear(pool.filter((x) => x.modulo === modulo), MOD_QTD, evitar);
      } else if (c.pagina) {
        if (prog.certificado) return json({ ok: true, certificado: prog.certificado });
        const faltam = Array.from({ length: c.modulos_total || 0 }, (_, i) => i + 1).filter((m) => !prog.modulos_ok.includes(m));
        if (faltam.length) return json({ erro: "Conclua o teste de todos os módulos antes da avaliação final.", faltam }, 400);
        for (let m = 1; m <= c.modulos_total!; m++) escolhidas.push(...sortear(pool.filter((x) => x.modulo === m), 2, evitar));
        for (const m of shuffle(Array.from({ length: c.modulos_total! }, (_, i) => i + 1))) {
          if (escolhidas.length >= FINAL_QTD) break;
          const resto = pool.filter((x) => x.modulo === m && !escolhidas.some((e) => e.id === x.id));
          if (resto.length) escolhidas.push(sortear(resto, 1, evitar)[0]);
        }
        escolhidas = shuffle(escolhidas);
      } else {
        if (prog.certificado) return json({ ok: true, certificado: prog.certificado });
        const doCurso = await aulasDoCurso(c);
        if (!doCurso.every((id) => prog.aulas_feitas.includes(id))) return json({ erro: "Conclua todas as aulas para liberar os exercícios." }, 400);
        escolhidas = sortear(pool, qtdSorteio(pool.length), evitar);
      }
      if (!escolhidas.length) return json({ erro: "Ainda não há perguntas para este teste." }, 400);

      const questoes = escolhidas.map((x) => ({ id: x.id, ordem: shuffle(x.opcoes.map((_, i) => i)) }));
      const { data: t, error } = await sb.from("capacita_tentativas").insert({
        candidato_id: cand.id, curso_slug: c.slug, tipo, modulo, questoes, total: questoes.length,
      }).select("id").single();
      if (error) throw error;
      return json({
        ok: true, tentativa_id: t.id, tipo, modulo,
        minimo: tipo === "modulo" ? MOD_MIN : Math.ceil(questoes.length * APROVACAO),
        questoes: escolhidas.map((x, i) => ({ pergunta: x.pergunta, opcoes: questoes[i].ordem.map((k) => x.opcoes[k]) })),
      });
    }

    if (acao === "corrigir") {
      const { data: t } = await sb.from("capacita_tentativas").select("*").eq("id", body.tentativa_id).eq("candidato_id", cand.id).maybeSingle();
      if (!t) return json({ erro: "Teste não encontrado." }, 404);
      if (t.corrigido_em) return json({ erro: "Este teste já foi corrigido. Faça um novo." }, 400);
      if (Date.now() - new Date(t.criado_em).getTime() > VALIDADE_TENTATIVA_MIN * 60000) return json({ erro: "O tempo deste teste acabou. Faça um novo." }, 400);
      const c = await curso(t.curso_slug);
      if (!c) return json({ erro: "Curso não encontrado." }, 404);
      const resp: number[] = Array.isArray(body.respostas) ? body.respostas.map((x: unknown) => Number(x)) : [];
      const qs = t.questoes as { id: string; ordem: number[] }[];
      if (resp.length !== qs.length) return json({ erro: "Responda todas as perguntas." }, 400);

      const porId = new Map((await perguntas(c, qs.map((x) => x.id))).map((b) => [b.id, b]));
      let acertos = 0; const erros: Record<number, number> = {};
      const correcao = qs.map((q, i) => {
        const p = porId.get(q.id);
        const certa = q.ordem.indexOf(p ? p.correta : 0);
        const ok = resp[i] === certa; if (ok) acertos++;
        else if (p?.modulo) erros[p.modulo] = (erros[p.modulo] || 0) + 1;
        return { correta: certa, acertou: ok, explicacao: p?.explicacao || "" };
      });
      const aprovado = t.tipo === "modulo" ? acertos >= MOD_MIN : acertos / qs.length >= APROVACAO;
      await sb.from("capacita_tentativas").update({ acertos, aprovado, corrigido_em: new Date().toISOString() }).eq("id", t.id);

      // teste de módulo: mostra a correção para estudar
      if (t.tipo === "modulo") return json({ ok: true, acertos, total: qs.length, aprovado, correcao });

      // avaliação final: só o resultado, sem gabarito
      const nota = Math.round(acertos / qs.length * 100);
      if (!aprovado) return json({ ok: true, acertos, total: qs.length, nota, aprovado, minimo: Math.ceil(qs.length * APROVACAO), erros_por_modulo: erros });
      const cert = await emitirCertificado(cand, c, acertos, qs.length);
      return json({ ok: true, acertos, total: qs.length, nota, aprovado, certificado: certPublico(cert) });
    }

    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: "Não foi possível concluir agora. Tente novamente." }, 500);
  }
});
