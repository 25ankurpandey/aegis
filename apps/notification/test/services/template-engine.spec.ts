import { interpolate, TemplateEngine } from '../../src/services/template-engine';

describe('template engine', () => {
  describe('interpolate', () => {
    it('substitutes named placeholders from the vars map', () => {
      expect(interpolate('Hi {{name}}, {{count}} new', { name: 'Ada', count: 3 })).toBe(
        'Hi Ada, 3 new',
      );
    });

    it('tolerates whitespace inside the braces', () => {
      expect(interpolate('{{ a }}-{{b}}', { a: 'x', b: 'y' })).toBe('x-y');
    });

    it('renders a missing or null variable as empty string (never the literal token)', () => {
      expect(interpolate('a{{missing}}b{{nul}}c', { nul: null })).toBe('abc');
    });

    it('coerces boolean and numeric values to strings', () => {
      expect(interpolate('{{flag}}/{{n}}', { flag: true, n: 0 })).toBe('true/0');
    });

    it('leaves text with no placeholders unchanged', () => {
      expect(interpolate('plain body', {})).toBe('plain body');
    });
  });

  describe('TemplateEngine', () => {
    it('renders a registered named template into RenderedContent', () => {
      const engine = new TemplateEngine([
        { name: 'welcome', subject: 'Hello {{who}}', body: 'Body for {{who}}', html: '<p>{{who}}</p>' },
      ]);
      const content = engine.render('welcome', { who: 'world' });
      expect(content).toEqual({
        subject: 'Hello world',
        body: 'Body for world',
        html: '<p>world</p>',
        template: 'welcome',
      });
    });

    it('supports register() chaining and has()', () => {
      const engine = new TemplateEngine();
      engine.register({ name: 'a', subject: 's', body: 'b' }).register({ name: 'c', subject: 's', body: 'b' });
      expect(engine.has('a')).toBe(true);
      expect(engine.has('c')).toBe(true);
      expect(engine.has('z')).toBe(false);
    });

    it('throws on an unregistered template name (never a silent empty send)', () => {
      const engine = new TemplateEngine();
      expect(() => engine.render('nope', {})).toThrow(/no notification template/i);
    });
  });
});
