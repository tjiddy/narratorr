import { describe, it, expect } from 'vitest';
import {
  parseFolderStructure,
  parseFolderStructureRaw,
  cleanName,
  cleanNameWithTrace,
  cleanTagTitle,
  extractYear,
  extractASIN,
  normalizeFolderName,
  CODEC_TEST_REGEX,
} from './folder-parsing.js';

describe('folder-parsing (extracted from library-scan.service)', () => {
  describe('parseFolderStructure', () => {
    it('returns Unknown title for empty parts array', () => {
      expect(parseFolderStructure([])).toEqual({ title: 'Unknown', author: null, series: null });
    });

    it('delegates single-element array to parseSingleFolder', () => {
      const result = parseFolderStructure(['Author - Title']);
      expect(result).toEqual({ title: 'Title', author: 'Author', series: null });
    });

    it('parses 2-part array as Author/Title', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBeNull();
    });

    it('parses 2-part array with Series–NN–Title in second segment', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive - 1 - The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBe('Stormlight Archive');
    });

    it('parses 3-part array as Author/Series/Title', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive', 'The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBe('Stormlight Archive');
    });

    it('parses 4+ part array using first, second-to-last, last', () => {
      const result = parseFolderStructure(['Author', 'SubDir', 'Series', 'Title']);
      expect(result.author).toBe('Author');
      expect(result.title).toBe('Title');
      expect(result.series).toBe('Series');
    });

    describe('audio extension stripping for single-file discoveries (issue #982)', () => {
      it.each(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aac'])(
        '1-part: strips %s extension before parsing',
        (ext) => {
          const result = parseFolderStructure([`Doctor Sleep${ext}`]);
          expect(result).toEqual({ title: 'Doctor Sleep', author: null, series: null });
        },
      );

      it('1-part Author - Title.m4b → author + title (extension stripped)', () => {
        const result = parseFolderStructure(['Brandon Sanderson - The Way of Kings.m4b']);
        expect(result).toMatchObject({
          title: 'The Way of Kings',
          author: 'Brandon Sanderson',
          series: null,
        });
      });

      it('1-part Title by Author.mp3 → author + title (extension stripped)', () => {
        const result = parseFolderStructure(['The Stand by Stephen King.mp3']);
        expect(result).toMatchObject({
          title: 'The Stand',
          author: 'Stephen King',
          series: null,
        });
      });

      it('2-part Author/Title.m4b → author + title (extension stripped from title segment)', () => {
        const result = parseFolderStructure(['Stephen King', 'Doctor Sleep.m4b']);
        expect(result).toMatchObject({
          title: 'Doctor Sleep',
          author: 'Stephen King',
          series: null,
        });
      });

      it('3-part Author/Series/Title.flac → author + series + title (extension stripped)', () => {
        const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive', 'The Way of Kings.flac']);
        expect(result).toMatchObject({
          title: 'The Way of Kings',
          author: 'Brandon Sanderson',
          series: 'Stormlight Archive',
        });
      });

      it('does not strip non-audio extensions (.txt is not in AUDIO_EXTENSIONS)', () => {
        // Title still flows through cleanName afterwards (which normalises dots to
        // spaces); the assertion is that the .txt suffix is NOT removed before parsing.
        const result = parseFolderStructure(['Book.txt']);
        expect(result.title).not.toBe('Book');
      });

      it('extension match is case-insensitive', () => {
        const result = parseFolderStructure(['Doctor Sleep.M4B']);
        expect(result).toEqual({ title: 'Doctor Sleep', author: null, series: null });
      });
    });

    describe('2-part with all-numeric date-like title (issue #701)', () => {
      it('Stephen King/11-22-63 → title=11-22-63, author=Stephen King, no series', () => {
        expect(parseFolderStructure(['Stephen King', '11-22-63'])).toEqual({
          title: '11-22-63', author: 'Stephen King', series: null,
        });
      });

      it('Author/11.22.63 → title=11.22.63, no series', () => {
        expect(parseFolderStructure(['Author', '11.22.63'])).toEqual({
          title: '11.22.63', author: 'Author', series: null,
        });
      });

      it('Author/1.5 → title=1.5, no series', () => {
        expect(parseFolderStructure(['Author', '1.5'])).toEqual({
          title: '1.5', author: 'Author', series: null,
        });
      });

      it('Author/Catch-22 (alpha present) keeps original parsing — guard does not fire', () => {
        const result = parseFolderStructure(['Author', 'Catch-22']);
        expect(result.author).toBe('Author');
        expect(result.title).toBe('Catch-22');
        expect(result.series).toBeNull();
      });

      it('Author/1Q84 (alpha present) keeps original parsing', () => {
        const result = parseFolderStructure(['Author', '1Q84']);
        expect(result.title).toBe('1Q84');
      });

      it('Author/100 Years of Solitude (alpha present) keeps original parsing', () => {
        const result = parseFolderStructure(['Author', '100 Years of Solitude']);
        expect(result.title).toBe('100 Years of Solitude');
      });

      it('Author/2001 (single number, not multi-segment) keeps original parsing', () => {
        const result = parseFolderStructure(['Author', '2001']);
        // Single 4-digit year — guard's {1,2} requires at least one separator,
        // so '2001' alone doesn't trigger; falls through to bare-year strip.
        expect(result.title).toBe('2001');
      });

      it('Author/Series - 1 - Title (real series pattern) still parses with series', () => {
        const result = parseFolderStructure(['Author', 'Series - 1 - Title']);
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
        expect(result.title).toBe('Title');
      });
    });

    describe('3+-part with all-numeric date-like title (issue #701, F1)', () => {
      it('Author/Series/11.22.63 → title=11.22.63 (3+-part path runs cleanName, which must short-circuit)', () => {
        const result = parseFolderStructure(['Author', 'Series', '11.22.63']);
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
        expect(result.title).toBe('11.22.63');
      });

      it('Author/Series/11-22-63 → title=11-22-63', () => {
        const result = parseFolderStructure(['Author', 'Series', '11-22-63']);
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
        expect(result.title).toBe('11-22-63');
      });

      it('Author/SubDir/Series/11.22.63 (4-part) still preserves dot-separated title', () => {
        const result = parseFolderStructure(['Author', 'SubDir', 'Series', '11.22.63']);
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
        expect(result.title).toBe('11.22.63');
      });
    });
  });

  describe('parseSingleFolder (via parseFolderStructure with 1 part)', () => {
    it('parses "Author - Title" pattern', () => {
      const result = parseFolderStructure(['Andy Weir - Project Hail Mary']);
      expect(result).toEqual({ title: 'Project Hail Mary', author: 'Andy Weir', series: null });
    });

    // Issue #977: the old "Title (Author)" / "Title [Author]" heuristic produced
    // wrong-direction parses on the much-more-common Title(Series) / Title[MediaTag]
    // shapes. Path 1 is now strictly conservative — the parens content is stripped
    // by NARRATOR_PAREN_REGEX (parens) or bracketTagStrip (brackets), and author
    // falls through to null. A future Path 2 (heuristic candidate-generator with
    // metadata validation) will recover legitimate Title(Author) cases.
    it('"Title (Author)" no longer parses as title+author — parens content is stripped, author=null', () => {
      const result = parseFolderStructure(['Dune (Frank Herbert)']);
      expect(result).toEqual({ title: 'Dune', author: null, series: null });
    });

    it('"Title [Author]" no longer parses as title+author — brackets content is stripped, author=null', () => {
      const result = parseFolderStructure(['Dune [Frank Herbert]']);
      expect(result).toEqual({ title: 'Dune', author: null, series: null });
    });

    it('parses "Series – NN – Title" pattern with en-dash', () => {
      const result = parseFolderStructure(['Stormlight Archive – 1 – The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('parses "Series - NN - Title" pattern with hyphen', () => {
      const result = parseFolderStructure(['Stormlight Archive - 1 - The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('skips dash pattern when left side is just a number', () => {
      const result = parseFolderStructure(['01 - The Way of Kings']);
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns title only when no pattern matches', () => {
      const result = parseFolderStructure(['JustATitle']);
      expect(result).toEqual({ title: 'JustATitle', author: null, series: null });
    });

    describe('all-numeric date-like inputs (issue #701)', () => {
      it('1-part 11-22-63 keeps full value as title', () => {
        expect(parseFolderStructure(['11-22-63'])).toEqual({
          title: '11-22-63', author: null, series: null,
        });
      });

      it('1-part 11.22.63 keeps full value as title', () => {
        expect(parseFolderStructure(['11.22.63'])).toEqual({
          title: '11.22.63', author: null, series: null,
        });
      });

      it('1-part 1.5 keeps full value as title', () => {
        expect(parseFolderStructure(['1.5'])).toEqual({
          title: '1.5', author: null, series: null,
        });
      });

      it('1-part Foundation - 02 - Second Foundation still parses as series/title (guard scoped)', () => {
        const result = parseFolderStructure(['Foundation - 02 - Second Foundation']);
        expect(result.series).toBe('Foundation');
        expect(result.title).toBe('Second Foundation');
        expect(result.author).toBeNull();
      });

      it('1-part Author - Real Title still parses as author/title', () => {
        const result = parseFolderStructure(['Author - Real Title']);
        expect(result.author).toBe('Author');
        expect(result.title).toBe('Real Title');
        expect(result.series).toBeNull();
      });
    });

    describe('targeted parser rules (issue #980)', () => {
      describe('P4 — "Series, Book NN - Title"', () => {
        it('Discworld, Book 16 - Soul Music (Read by Nigel Planer) → series + seriesPosition + title (with P5 strip)', () => {
          expect(parseFolderStructure(['Discworld, Book 16 - Soul Music (Read by Nigel Planer)'])).toEqual({
            series: 'Discworld', title: 'Soul Music', author: null, seriesPosition: 16,
          });
        });

        it('Discworld, Book 38 - I Shall Wear Midnight (Read by Stephen Briggs) → series + seriesPosition + title', () => {
          expect(parseFolderStructure(['Discworld, Book 38 - I Shall Wear Midnight (Read by Stephen Briggs)'])).toEqual({
            series: 'Discworld', title: 'I Shall Wear Midnight', author: null, seriesPosition: 38,
          });
        });

        it('Discworld, Book 7 - Pyramids (no narrator paren) → series + title only', () => {
          expect(parseFolderStructure(['Discworld, Book 7 - Pyramids'])).toEqual({
            series: 'Discworld', title: 'Pyramids', author: null, seriesPosition: 7,
          });
        });

        it('Foo, Book 99 alone (no dash) does NOT match P4 — falls through to title-only via cleanName seriesMarker strip', () => {
          const result = parseFolderStructure(['Foo, Book 99']);
          expect(result.series).toBeNull();
          expect(result.author).toBeNull();
          expect(result.title).toBe('Foo');
          expect(result.seriesPosition).toBeUndefined();
        });
      });

      describe('P5 — "(Read by NAME)" / "(Narrated by NAME)" parens regardless of word count', () => {
        it('cleanName strips 4-word "(Read by ...)"', () => {
          expect(cleanName('Soul Music (Read by Nigel Planer)')).toBe('Soul Music');
        });

        it('cleanName strips "(Narrated by ...)"', () => {
          expect(cleanName('Foo (Narrated by Some Long Multi-Word Reader)')).toBe('Foo');
        });
      });

      describe('P6 — edition-annotation parens', () => {
        it('cleanName strips "(2007 Full Cast Recording)" via year prefix', () => {
          expect(cleanName('Dune (2007 Full Cast Recording)')).toBe('Dune');
        });

        it('cleanName strips "(20th Anniversary Edition)" via ordinal prefix', () => {
          expect(cleanName('Heir to the Empire (20th Anniversary Edition)')).toBe('Heir to the Empire');
        });

        it("cleanName strips \"(Director's Cut)\" via Cut keyword", () => {
          expect(cleanName("Title (Director's Cut)")).toBe('Title');
        });

        it('cleanName strips "(The Extended Cut Edition)" via keyword', () => {
          expect(cleanName('Title (The Extended Cut Edition)')).toBe('Title');
        });

        it('cleanName preserves "(Foo Bar Baz Qux)" — no edition keyword, year, or ordinal prefix', () => {
          expect(cleanName('Title (Foo Bar Baz Qux)')).toBe('Title (Foo Bar Baz Qux)');
        });

        it('cleanName preserves "(Dr Stephen King Jr)" — no edition keyword (4 words bypasses NARRATOR_PAREN_REGEX cap)', () => {
          expect(cleanName('Title (Dr Stephen King Jr)')).toBe('Title (Dr Stephen King Jr)');
        });

        it('parseFolderStructure: Frank Herbert - Dune (2007 Full Cast Recording) → P6 strips paren after dash heuristic', () => {
          expect(parseFolderStructure(['Frank Herbert - Dune (2007 Full Cast Recording)'])).toEqual({
            author: 'Frank Herbert', title: 'Dune', series: null,
          });
        });
      });

      describe('P8 — recursive "Author - Series" split in 2-part author segment', () => {
        it("Douglas Adams - The Hitchhikers Guide.../1-The Hitchhikers Guide... → author + series + title (cleaned)", () => {
          const result = parseFolderStructure([
            'Douglas Adams - The Hitchhikers Guide to the Galaxy',
            '1-The Hitchhikers Guide To The Galaxy',
          ]);
          expect(result.author).toBe('Douglas Adams');
          expect(result.series).toBe('The Hitchhikers Guide to the Galaxy');
          expect(result.title).toBe('The Hitchhikers Guide To The Galaxy');
        });

        it('Sanderson - Mistborn/01 - The Final Empire → author=Sanderson, series=Mistborn, title=The Final Empire', () => {
          const result = parseFolderStructure(['Sanderson - Mistborn', '01 - The Final Empire']);
          expect(result.author).toBe('Sanderson');
          expect(result.series).toBe('Mistborn');
          expect(result.title).toBe('The Final Empire');
        });

        it('raw mirror: Douglas Adams - The Hitchhikers Guide.../1-The Hitchhikers Guide... → P8 recurses via parseSingleFolderRaw', () => {
          const result = parseFolderStructureRaw([
            'Douglas Adams - The Hitchhikers Guide to the Galaxy',
            '1-The Hitchhikers Guide To The Galaxy',
          ]);
          expect(result.author).toBe('Douglas Adams');
          expect(result.series).toBe('The Hitchhikers Guide to the Galaxy');
          expect(result.title).toBe('1-The Hitchhikers Guide To The Galaxy');
        });

        it('Just Author/Title (no dash in author segment) → existing 2-part behavior, series=null', () => {
          const result = parseFolderStructure(['Just Author', 'Title']);
          expect(result.author).toBe('Just Author');
          expect(result.title).toBe('Title');
          expect(result.series).toBeNull();
        });

        it('Douglas Adams – Hitchhiker/Title (en-dash author segment) → P8 does NOT fire; whole segment is author', () => {
          const result = parseFolderStructure(['Douglas Adams – Hitchhiker', 'Title']);
          expect(result.author).toBe('Douglas Adams – Hitchhiker');
          expect(result.series).toBeNull();
        });
      });

      describe('P9 — Last, First author swap (after dash/by heuristics)', () => {
        it('Liu, Cixin - The Three-Body Problem → author swapped to "Cixin Liu"', () => {
          const result = parseFolderStructure(['Liu, Cixin - The Three-Body Problem']);
          expect(result.author).toBe('Cixin Liu');
          expect(result.title).toBe('The Three-Body Problem');
        });

        it('Asimov, Isaac - Foundation → author swapped to "Isaac Asimov"', () => {
          const result = parseFolderStructure(['Asimov, Isaac - Foundation']);
          expect(result.author).toBe('Isaac Asimov');
          expect(result.title).toBe('Foundation');
        });

        it('Foo, Bar Baz - Title (3+ tokens after comma) → no swap', () => {
          const result = parseFolderStructure(['Foo, Bar Baz - Title']);
          expect(result.author).toBe('Foo, Bar Baz');
          expect(result.title).toBe('Title');
        });
      });

      describe('P10 — "<series> NN - <title>" mid-title pattern', () => {
        describe('precheck (no-author path, fires before dash heuristic)', () => {
          it('Murderbot Diaries 07 - System Collapse → series + seriesPosition + title, author=null', () => {
            expect(parseFolderStructure(['Murderbot Diaries 07 - System Collapse'])).toEqual({
              series: 'Murderbot Diaries', title: 'System Collapse', author: null, seriesPosition: 7,
            });
          });

          it('Three Body 01 - The Three-Body Problem → series + seriesPosition + title, author=null', () => {
            expect(parseFolderStructure(['Three Body 01 - The Three-Body Problem'])).toEqual({
              series: 'Three Body', title: 'The Three-Body Problem', author: null, seriesPosition: 1,
            });
          });

          it('Foo 07 - Title (single-word series) → series=Foo, seriesPosition=7, title=Title', () => {
            expect(parseFolderStructure(['Foo 07 - Title'])).toEqual({
              series: 'Foo', title: 'Title', author: null, seriesPosition: 7,
            });
          });

          it('Author - Title (no number) → P10 regex does not match; dash heuristic resolves', () => {
            const result = parseFolderStructure(['Author - Title']);
            expect(result.author).toBe('Author');
            expect(result.title).toBe('Title');
            expect(result.series).toBeNull();
            expect(result.seriesPosition).toBeUndefined();
          });

          it('01 - Title (digit-only prefix) → P10 regex does not match; existing leadingNumeric strip behavior', () => {
            const result = parseFolderStructure(['01 - Title']);
            expect(result.title).toBe('Title');
            expect(result.author).toBeNull();
            expect(result.series).toBeNull();
          });
        });

        describe('postprocess (author-dash path, fires after dash heuristic)', () => {
          it('Martha Wells - Murderbot Diaries 07 - System Collapse → author + series + seriesPosition + title', () => {
            expect(parseFolderStructure(['Martha Wells - Murderbot Diaries 07 - System Collapse'])).toEqual({
              author: 'Martha Wells', series: 'Murderbot Diaries', title: 'System Collapse', seriesPosition: 7,
            });
          });

          it('Liu, Cixin - Three Body 01 - The Three-Body Problem 2014 mp3 → P9 + P10-postprocess + cleanName year/codec strip', () => {
            expect(parseFolderStructure(['Liu, Cixin - Three Body 01 - The Three-Body Problem 2014 mp3'])).toEqual({
              author: 'Cixin Liu', series: 'Three Body', title: 'The Three-Body Problem', seriesPosition: 1,
            });
          });
        });
      });

      describe('P15 — whole-input lowercase kebab-case bail', () => {
        it('believe-me → author=null, series=null', () => {
          const result = parseFolderStructure(['believe-me']);
          expect(result.author).toBeNull();
          expect(result.series).toBeNull();
        });

        it('dont-look-up (3 segments) → author=null, series=null', () => {
          const result = parseFolderStructure(['dont-look-up']);
          expect(result.author).toBeNull();
          expect(result.series).toBeNull();
        });

        it('apple-pie-recipes (3 segments) → author=null, series=null', () => {
          const result = parseFolderStructure(['apple-pie-recipes']);
          expect(result.author).toBeNull();
          expect(result.series).toBeNull();
        });

        it('Author - Title (capitalized) → P15 does not fire; dash heuristic resolves', () => {
          const result = parseFolderStructure(['Author - Title']);
          expect(result.author).toBe('Author');
          expect(result.title).toBe('Title');
        });

        it('lowercase title (space, no hyphens) → P15 does not fire', () => {
          const result = parseFolderStructure(['lowercase title']);
          expect(result.author).toBeNull();
          expect(result.title).toBe('lowercase title');
        });
      });

      describe('post-#977 + P5/P6: "Title by Author (annotation)"', () => {
        it('The Martian by Andy Weir (alt) → author=Andy Weir, title=The Martian (narratorParen strips "(alt)")', () => {
          expect(parseFolderStructure(['The Martian by Andy Weir (alt)'])).toEqual({
            author: 'Andy Weir', title: 'The Martian', series: null,
          });
        });
      });

      describe('regression checks (post-#977)', () => {
        it('Blood Ties (World of Warcraft) still title-only', () => {
          expect(parseFolderStructure(['Blood Ties (World of Warcraft)'])).toEqual({
            title: 'Blood Ties', author: null, series: null,
          });
        });

        it('Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA] still strips [GA]', () => {
          const result = parseFolderStructure(['Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA]']);
          expect(result.author).toBe('Brandon Sanderson');
          expect(result.title).not.toContain('[GA]');
        });
      });
    });

    describe('parens/bracket-as-author removal (issue #977)', () => {
      it('AC1: Blood Ties (World of Warcraft) → title-only, parens stripped by NARRATOR_PAREN_REGEX', () => {
        expect(parseFolderStructure(['Blood Ties (World of Warcraft)'])).toEqual({
          title: 'Blood Ties', author: null, series: null,
        });
      });

      it('AC2: Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA] → author=Brandon Sanderson, title without [GA]', () => {
        const result = parseFolderStructure(['Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA]']);
        expect(result.author).toBe('Brandon Sanderson');
        expect(result.title).toBe('The Way of Kings - The Stormlight Archive 1');
        expect(result.series).toBeNull();
        // Critical: author must NOT be 'GA' (the previous wrong-direction parse)
        expect(result.author).not.toBe('GA');
      });

      it('AC3: Christie Golden - Sylvanas (World of Warcraft) → author=Christie Golden, title=Sylvanas', () => {
        const result = parseFolderStructure(['Christie Golden - Sylvanas (World of Warcraft)']);
        expect(result.author).toBe('Christie Golden');
        expect(result.title).toBe('Sylvanas');
        expect(result.series).toBeNull();
      });

      it('Sylvanas (World of Warcraft) → title-only fallback', () => {
        expect(parseFolderStructure(['Sylvanas (World of Warcraft)'])).toEqual({
          title: 'Sylvanas', author: null, series: null,
        });
      });

      it('The Hobbit (J.R.R. Tolkien) → title-only with parens content kept (deliberate regression: Path 2 will recover via metadata)', () => {
        // Path 1 regression: previously author='J.R.R. Tolkien'. Now author=null
        // and the parens content survives because normalizeFolderName converts
        // 'J.R.R.' dots to spaces, producing 'J R R Tolkien' (4 tokens) which
        // exceeds NARRATOR_PAREN_REGEX's 1-3 word limit. Path 2 (metadata-driven
        // candidate generation) will recover the legitimate Title(Author) case.
        const result = parseFolderStructure(['The Hobbit (J.R.R. Tolkien)']);
        expect(result.author).toBeNull();
        expect(result.series).toBeNull();
        expect(result.title).toBe('The Hobbit (J R R Tolkien)');
      });
    });

    describe('bracket-tag stripping in multi-part paths (issue #977)', () => {
      it('AC8: ASIN extraction still works (extractASIN runs before bracketTagStrip)', () => {
        const result = parseFolderStructure(['Some Title [B0123ABCD4]']);
        expect(result.asin).toBe('B0123ABCD4');
        expect(result.title).toBe('Some Title');
        expect(result.title).not.toContain('B0123ABCD4');
      });

      it('2-part: Andy Weir/Project Hail Mary [Unabridged] strips [Unabridged]', () => {
        const result = parseFolderStructure(['Andy Weir', 'Project Hail Mary [Unabridged]']);
        expect(result.title).toBe('Project Hail Mary');
        expect(result.author).toBe('Andy Weir');
      });

      it('3-part: Sanderson/Stormlight/Way of Kings [GA] strips [GA] from title', () => {
        const result = parseFolderStructure(['Sanderson', 'Stormlight', 'Way of Kings [GA]']);
        expect(result.title).toBe('Way of Kings');
        expect(result.series).toBe('Stormlight');
        expect(result.author).toBe('Sanderson');
      });
    });

    describe('TITLE_DASH_SERIES_BOOK pattern (Title - Series, Book N) (issue #1034)', () => {
      it('AC2: narrator-paren disambiguator — The Dark Forest - The Three-Body Problem, Book 2 (Bruno Roubicek)', () => {
        expect(parseFolderStructure(['The Dark Forest - The Three-Body Problem, Book 2 (Bruno Roubicek)'])).toEqual({
          title: 'The Dark Forest',
          author: null,
          series: 'The Three-Body Problem',
          seriesPosition: 2,
        });
      });

      it('AC3: by-Author disambiguator — Imagine Me - Shatter Me Series, Book 6 by Tahereh Mafi', () => {
        expect(parseFolderStructure(['Imagine Me - Shatter Me Series, Book 6 by Tahereh Mafi'])).toEqual({
          title: 'Imagine Me',
          author: 'Tahereh Mafi',
          series: 'Shatter Me Series',
          seriesPosition: 6,
        });
      });

      it('AC4: fractional position via narrator-paren — Mistborn - Mistborn, Book 1.5 (Michael Kramer)', () => {
        expect(parseFolderStructure(['Mistborn - Mistborn, Book 1.5 (Michael Kramer)'])).toEqual({
          title: 'Mistborn',
          author: null,
          series: 'Mistborn',
          seriesPosition: 1.5,
        });
      });

      it('AC5: rightmost-dash split — Some Long Title - With Dashes - Series Name, Book 5 (Narrator)', () => {
        const result = parseFolderStructure(['Some Long Title - With Dashes - Series Name, Book 5 (Narrator)']);
        expect(result.title).toBe('Some Long Title - With Dashes');
        expect(result.series).toBe('Series Name');
        expect(result.seriesPosition).toBe(5);
        expect(result.author).toBeNull();
      });

      it('series-keyword disambiguator (saga) fires without narrator paren or by-Author', () => {
        const result = parseFolderStructure(['The Last Stand - Galactic Saga, Book 3']);
        expect(result.title).toBe('The Last Stand');
        expect(result.series).toBe('Galactic Saga');
        expect(result.seriesPosition).toBe(3);
        expect(result.author).toBeNull();
      });

      it('series-keyword disambiguator is case-insensitive (CHRONICLES)', () => {
        const result = parseFolderStructure(['Foo - Bar CHRONICLES, Book 2']);
        expect(result.series).toBe('Bar CHRONICLES');
        expect(result.seriesPosition).toBe(2);
      });

      it('AC6: no disambiguator — Brandon Sanderson - Mistborn, Book 1 falls through to dash heuristic', () => {
        const result = parseFolderStructure(['Brandon Sanderson - Mistborn, Book 1']);
        expect(result.author).toBe('Brandon Sanderson');
        expect(result.title).toBe('Mistborn');
        expect(result.series).toBeNull();
      });

      it('AC7: year-paren rejected as narrator disambiguator — Brandon Sanderson - Mistborn, Book 1 (2020)', () => {
        const result = parseFolderStructure(['Brandon Sanderson - Mistborn, Book 1 (2020)']);
        expect(result.author).toBe('Brandon Sanderson');
        expect(result.series).toBeNull();
        expect(result.title).not.toBe('Brandon Sanderson');
      });

      it('AC8: codec-paren rejected as narrator disambiguator — Author - Title, Book 1 (Unabridged)', () => {
        const result = parseFolderStructure(['Author - Title, Book 1 (Unabridged)']);
        expect(result.author).toBe('Author');
        expect(result.series).toBeNull();
      });

      it('AC9: edition-paren rejected as narrator disambiguator — Author - Title, Book 1 (Anniversary Edition)', () => {
        const result = parseFolderStructure(['Author - Title, Book 1 (Anniversary Edition)']);
        expect(result.author).toBe('Author');
        expect(result.series).toBeNull();
      });

      it('AC10: existing #977 regression preserved — Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA]', () => {
        const result = parseFolderStructure(['Brandon Sanderson - The Way of Kings - The Stormlight Archive 1 [GA]']);
        expect(result.author).toBe('Brandon Sanderson');
        expect(result.title).toBe('The Way of Kings - The Stormlight Archive 1');
        expect(result.series).toBeNull();
      });

      it('preserves P4 ordering — Discworld, Book 16 - Soul Music still hits SERIES_BOOK_DASH_TITLE_REGEX', () => {
        const result = parseFolderStructure(['Discworld, Book 16 - Soul Music']);
        expect(result.series).toBe('Discworld');
        expect(result.seriesPosition).toBe(16);
        expect(result.title).toBe('Soul Music');
        expect(result.author).toBeNull();
      });

      it('does NOT preempt all-numeric short-circuit — 1.5', () => {
        expect(parseFolderStructure(['1.5'])).toEqual({ title: '1.5', author: null, series: null });
      });

      it('AC22 raw parity: AC2 case', () => {
        const result = parseFolderStructureRaw(['The Dark Forest - The Three-Body Problem, Book 2 (Bruno Roubicek)']);
        expect(result.author).toBeNull();
        expect(result.series).toBe('The Three-Body Problem');
        expect(result.seriesPosition).toBe(2);
        expect(result.title).toBe('The Dark Forest');
      });

      it('AC22 raw parity: AC3 case', () => {
        const result = parseFolderStructureRaw(['Imagine Me - Shatter Me Series, Book 6 by Tahereh Mafi']);
        expect(result.title).toBe('Imagine Me');
        expect(result.series).toBe('Shatter Me Series');
        expect(result.author).toBe('Tahereh Mafi');
        expect(result.seriesPosition).toBe(6);
      });

      it('AC22 raw parity: AC4 fractional position', () => {
        const result = parseFolderStructureRaw(['Mistborn - Mistborn, Book 1.5 (Michael Kramer)']);
        expect(result.seriesPosition).toBe(1.5);
        expect(result.title).toBe('Mistborn');
        expect(result.series).toBe('Mistborn');
        expect(result.author).toBeNull();
      });
    });

    describe('cross-segment agreement (2-part Series-folder + series-prefixed filename) (issue #1034)', () => {
      it('AC17: Roman + underscore — Dune Saga / Dune Chronicles I_ Dune', () => {
        expect(parseFolderStructure(['Dune Saga', 'Dune Chronicles I_ Dune'])).toEqual({
          title: 'Dune',
          author: null,
          series: 'Dune Saga',
          seriesPosition: 1,
        });
      });

      it('AC18: decimal + hyphen, no whitespace — Reacher / Reacher 00.15-Second Son', () => {
        expect(parseFolderStructure(['Reacher', 'Reacher 00.15-Second Son'])).toEqual({
          title: 'Second Son',
          author: null,
          series: 'Reacher',
          seriesPosition: 0.15,
        });
      });

      it('AC16: ASIN preserved — Reacher / Reacher 00.15-Second Son [B0D18DYG5C]', () => {
        const result = parseFolderStructure(['Reacher', 'Reacher 00.15-Second Son [B0D18DYG5C]']);
        expect(result).toEqual({
          title: 'Second Son',
          author: null,
          series: 'Reacher',
          seriesPosition: 0.15,
          asin: 'B0D18DYG5C',
        });
      });

      it('AC19: distinctive-token negative — The Series / The Adventure (only stopwords overlap)', () => {
        const result = parseFolderStructure(['The Series', 'The Adventure']);
        expect(result.author).toBe('The Series');
        expect(result.title).toBe('The Adventure');
        expect(result.series).toBeNull();
      });

      it('AC20: filename-evidence required — Dune Saga / Some Random Book', () => {
        const result = parseFolderStructure(['Dune Saga', 'Some Random Book']);
        expect(result.author).toBe('Dune Saga');
        expect(result.title).toBe('Some Random Book');
        expect(result.series).toBeNull();
      });

      it('AC21: author-not-confused — Andy Weir / Project Hail Mary', () => {
        const result = parseFolderStructure(['Andy Weir', 'Project Hail Mary']);
        expect(result.author).toBe('Andy Weir');
        expect(result.title).toBe('Project Hail Mary');
        expect(result.series).toBeNull();
      });

      it('subtractive Roman (IV) — Foundation IV / Foundation IV_The Quickening', () => {
        const result = parseFolderStructure(['Foundation IV', 'Foundation IV_The Quickening']);
        expect(result.series).toBe('Foundation IV');
        expect(result.seriesPosition).toBe(4);
        expect(result.title).toBe('The Quickening');
        expect(result.author).toBeNull();
      });

      it('multi-token Roman (XII) — Foundation XII / Foundation XII_Forward', () => {
        const result = parseFolderStructure(['Foundation XII', 'Foundation XII_Forward']);
        expect(result.seriesPosition).toBe(12);
        expect(result.title).toBe('Forward');
        expect(result.series).toBe('Foundation XII');
      });

      it('plain Arabic via cross-segment (underscore avoids WORDS_NUM_DASH preempt) — Foundation / Foundation 2_Chapter Two', () => {
        const result = parseFolderStructure(['Foundation', 'Foundation 2_Chapter Two']);
        expect(result.seriesPosition).toBe(2);
        expect(result.title).toBe('Chapter Two');
        expect(result.series).toBe('Foundation');
      });

      it('regex-miss fallback (NOT undefined-branch coverage) — Foundation / Foundation ABC_Title', () => {
        const result = parseFolderStructure(['Foundation', 'Foundation ABC_Title']);
        // SERIES_PREFIX_POSITION_REGEX cannot match (`ABC` is neither decimal nor IVX);
        // helper returns null at the regex check before parseRomanOrArabicPosition.
        // Falls through to 2-part default; cleanName normalizes `_` to space.
        expect(result.author).toBe('Foundation');
        expect(result.title).toBe('Foundation ABC Title');
        expect(result.series).toBeNull();
        expect(result.seriesPosition).toBeUndefined();
      });

      it('whitespace-tolerant separator — Reacher / Reacher 00.15- Second Son (space after only)', () => {
        const result = parseFolderStructure(['Reacher', 'Reacher 00.15- Second Son']);
        expect(result.seriesPosition).toBe(0.15);
        expect(result.title).toBe('Second Son');
        expect(result.series).toBe('Reacher');
      });

      it('whitespace-tolerant separator — Reacher / Reacher 00.15 - Second Son (spaces both sides)', () => {
        const result = parseFolderStructure(['Reacher', 'Reacher 00.15 - Second Son']);
        expect(result.seriesPosition).toBe(0.15);
        expect(result.title).toBe('Second Son');
        expect(result.series).toBe('Reacher');
      });

      it('cleanName leadingNumeric does NOT preempt — Reacher / 00.15-Second Son falls through (no series-prefix)', () => {
        const result = parseFolderStructure(['Reacher', '00.15-Second Son']);
        expect(result.seriesPosition).toBeUndefined();
      });

      it('AC22 raw parity: AC17 — Dune Saga / Dune Chronicles I_ Dune', () => {
        const result = parseFolderStructureRaw(['Dune Saga', 'Dune Chronicles I_ Dune']);
        expect(result.title).toBe('Dune');
        expect(result.series).toBe('Dune Saga');
        expect(result.seriesPosition).toBe(1);
        expect(result.author).toBeNull();
      });

      it('AC22 raw parity: AC18 — Reacher / Reacher 00.15-Second Son', () => {
        const result = parseFolderStructureRaw(['Reacher', 'Reacher 00.15-Second Son']);
        expect(result.title).toBe('Second Son');
        expect(result.series).toBe('Reacher');
        expect(result.seriesPosition).toBe(0.15);
        expect(result.author).toBeNull();
      });

      it('AC22 raw parity: AC16 — ASIN bracket stripped from raw title', () => {
        const result = parseFolderStructureRaw(['Reacher', 'Reacher 00.15-Second Son [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Second Son');
        expect(result.title).not.toContain('B0D18DYG5C');
        expect(result.series).toBe('Reacher');
        expect(result.seriesPosition).toBe(0.15);
      });

      it('AC22 raw parity: subtractive Roman — Foundation IV / Foundation IV_The Quickening', () => {
        const result = parseFolderStructureRaw(['Foundation IV', 'Foundation IV_The Quickening']);
        expect(result.seriesPosition).toBe(4);
        expect(result.title).toBe('The Quickening');
      });
    });
  });

  describe('cleanName', () => {
    it('strips leading decimal position prefix (6.5 - )', () => {
      expect(cleanName('6.5 - The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips leading integer position prefix (01 - )', () => {
      expect(cleanName('01 - The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips leading integer dot prefix (01. )', () => {
      expect(cleanName('01. The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips series markers (, Book 01)', () => {
      expect(cleanName('The Way of Kings, Book 01')).toBe('The Way of Kings');
    });

    it('normalizes underscores and dots to spaces', () => {
      expect(cleanName('The_Way.of.Kings')).toBe('The Way of Kings');
    });

    it('strips codec tags (MP3, M4B, FLAC)', () => {
      expect(cleanName('Title MP3')).toBe('Title');
    });

    it('strips trailing parenthesized year (2020)', () => {
      expect(cleanName('Title (2020)')).toBe('Title');
    });

    it('strips trailing bracketed year [2019]', () => {
      expect(cleanName('Title [2019]')).toBe('Title');
    });

    it('strips bare trailing year', () => {
      expect(cleanName('Title 2020')).toBe('Title');
    });

    it('removes empty parentheses after codec strip', () => {
      expect(cleanName('Title (MP3)')).toBe('Title');
    });

    it('removes empty brackets after codec strip', () => {
      expect(cleanName('Title [FLAC]')).toBe('Title');
    });

    it('strips trailing narrator parenthetical (1-3 word name)', () => {
      expect(cleanName('Title (Jeff Hays)')).toBe('Title');
    });

    it('does not strip narrator paren if content is codec tag', () => {
      // MP3 is a codec tag — should be handled by normalize step, not narrator step
      const result = cleanName('Title (MP3)');
      expect(result).toBe('Title');
    });

    it('deduplicates repeated title segments across dash', () => {
      expect(cleanName('Title 01 – Title')).toBe('Title');
    });

    it('falls back to original name when normalization strips everything', () => {
      expect(cleanName('MP3')).toBe('MP3');
    });

    it('strips non-year bracket media tags like [GA]', () => {
      expect(cleanName('Title [GA]')).toBe('Title');
    });

    it('strips [Unabridged] bracket tag', () => {
      expect(cleanName('Title [Unabridged]')).toBe('Title');
    });

    it('strips [Audible Studios] bracket tag', () => {
      expect(cleanName('Title [Audible Studios]')).toBe('Title');
    });

    it('strips [Full-Cast] bracket tag', () => {
      expect(cleanName('Title [Full-Cast]')).toBe('Title');
    });

    it('strips [Retail] bracket tag', () => {
      expect(cleanName('Title [Retail]')).toBe('Title');
    });

    it('strips multiple bracket tags from one string', () => {
      expect(cleanName('Some Title [Unabridged] [v2]')).toBe('Some Title');
    });

    it('preserves empty bracket strip behavior for "Some Title []"', () => {
      expect(cleanName('Some Title []')).toBe('Some Title');
    });

    describe('all-numeric date-like inputs (issue #701)', () => {
      it('preserves dash-separated date-like input like 11-22-63', () => {
        expect(cleanName('11-22-63')).toBe('11-22-63');
      });

      it('preserves two-segment numeric input like 1-5', () => {
        expect(cleanName('1-5')).toBe('1-5');
      });

      it('preserves dot-separated date-like input like 11.22.63 (would be mangled to "11 22 63" by normalizeFolderName)', () => {
        expect(cleanName('11.22.63')).toBe('11.22.63');
      });

      it('preserves decimal numeric input like 1.5 (would be mangled to "1 5" by normalizeFolderName)', () => {
        expect(cleanName('1.5')).toBe('1.5');
      });

      it('still strips leading-numeric prefix from alpha-bearing titles like 01 - The First Chapter', () => {
        expect(cleanName('01 - The First Chapter')).toBe('The First Chapter');
      });

      it('still strips leading-numeric prefix from 6.5 - Title', () => {
        expect(cleanName('6.5 - Edgedancer')).toBe('Edgedancer');
      });
    });
  });

  describe('cleanNameWithTrace', () => {
    it('returns all 13 steps with before/after values', () => {
      const trace = cleanNameWithTrace('Title');
      expect(trace.steps).toHaveLength(13);
      expect(trace.steps.map(s => s.name)).toEqual([
        'leadingNumeric', 'seriesMarker', 'normalize',
        'yearParenStrip', 'yearBracketStrip', 'bracketTagStrip', 'yearBareStrip',
        'emptyParenStrip', 'emptyBracketStrip',
        'narratorPrefixStrip', 'editionParenStrip',
        'narratorParen', 'dedup',
      ]);
    });

    it('each step reflects the actual transformation applied', () => {
      const trace = cleanNameWithTrace('01 - Title, Book 01');
      // leadingNumeric strips "01 - "
      expect(trace.steps[0]!.output).toBe('Title, Book 01');
      // seriesMarker strips ", Book 01" (end-of-string match)
      expect(trace.steps[1]!.output).toBe('Title');
      expect(trace.result).toBe('Title');
    });

    it('steps are in correct pipeline order', () => {
      const trace = cleanNameWithTrace('Title');
      const names = trace.steps.map(s => s.name);
      expect(names.indexOf('leadingNumeric')).toBeLessThan(names.indexOf('seriesMarker'));
      expect(names.indexOf('seriesMarker')).toBeLessThan(names.indexOf('normalize'));
      expect(names.indexOf('normalize')).toBeLessThan(names.indexOf('yearParenStrip'));
      expect(names.indexOf('narratorParen')).toBeLessThan(names.indexOf('dedup'));
    });

    it('no-op steps show same input/output', () => {
      const trace = cleanNameWithTrace('Clean Title');
      // leadingNumeric is a no-op for "Clean Title"
      expect(trace.steps[0]!.output).toBe('Clean Title');
    });

    it('returns final result matching non-trace cleanName output', () => {
      const inputs = [
        '01 - Title, Book 01 (2020)',
        'The_Way.of.Kings MP3',
        'Title (Jeff Hays)',
        'Title 01 – Title',
        'MP3',
        'Title [GA]',
      ];
      for (const input of inputs) {
        const trace = cleanNameWithTrace(input);
        expect(trace.result).toBe(cleanName(input));
      }
    });

    describe('all-numeric date-like inputs (issue #701)', () => {
      it('every step is a no-op for 11-22-63', () => {
        const trace = cleanNameWithTrace('11-22-63');
        expect(trace.steps).toHaveLength(13);
        for (const step of trace.steps) {
          expect(step.output).toBe('11-22-63');
        }
        expect(trace.result).toBe('11-22-63');
      });

      it('every step is a no-op for 11.22.63 (normalize would otherwise turn dots to spaces)', () => {
        const trace = cleanNameWithTrace('11.22.63');
        expect(trace.steps).toHaveLength(13);
        for (const step of trace.steps) {
          expect(step.output).toBe('11.22.63');
        }
        expect(trace.result).toBe('11.22.63');
      });

      it('trace result matches cleanName for 11-22-63 and 11.22.63', () => {
        expect(cleanNameWithTrace('11-22-63').result).toBe(cleanName('11-22-63'));
        expect(cleanNameWithTrace('11.22.63').result).toBe(cleanName('11.22.63'));
      });
    });
  });

  describe('normalizeFolderName', () => {
    it('replaces underscores with spaces', () => {
      expect(normalizeFolderName('The_Way_of_Kings')).toBe('The Way of Kings');
    });

    it('replaces dots with spaces', () => {
      expect(normalizeFolderName('The.Way.of.Kings')).toBe('The Way of Kings');
    });

    it('strips codec tags', () => {
      expect(normalizeFolderName('Title MP3 Unabridged')).toBe('Title');
    });

    it('collapses whitespace and trims', () => {
      expect(normalizeFolderName('  Title   Extra  ')).toBe('Title Extra');
    });
  });

  describe('extractYear', () => {
    it('extracts parenthesized year (2020)', () => {
      expect(extractYear('Title (2020)')).toBe(2020);
    });

    it('extracts bracketed year [2019]', () => {
      expect(extractYear('Title [2019]')).toBe(2019);
    });

    it('extracts bare trailing year', () => {
      expect(extractYear('Title 2017')).toBe(2017);
    });

    it('returns undefined when no year present', () => {
      expect(extractYear('Title')).toBeUndefined();
    });

    it('rejects years outside 1900-2099 range', () => {
      expect(extractYear('Title 1899')).toBeUndefined();
      expect(extractYear('Title 2100')).toBeUndefined();
    });
  });

  describe('parseFolderStructureRaw', () => {
    it('returns Unknown for empty parts', () => {
      expect(parseFolderStructureRaw([])).toEqual({ title: 'Unknown', author: null, series: null });
    });

    it('returns raw "Author - Title" from regex capture groups', () => {
      const result = parseFolderStructureRaw(['Andy Weir - Project Hail Mary']);
      // Dash regex: /^(.+?)\s*-\s*(.+)$/ — group 2 captures everything after "- "
      expect(result.author).toBe('Andy Weir');
      expect(result.title).toBe('Project Hail Mary');
    });

    // Issue #977: parens-as-author heuristic was removed from parseSingleFolderRaw
    // too. With no dash/by/series-NN match, these fall through to title-only with
    // the raw string preserved (raw must stay raw — no bracket stripping either).
    it('returns raw "Title (Author)" as title-only (parens heuristic removed)', () => {
      const result = parseFolderStructureRaw(['Dune (Frank Herbert)']);
      expect(result.title).toBe('Dune (Frank Herbert)');
      expect(result.author).toBeNull();
    });

    it('returns raw "Title [Author]" as title-only (parens heuristic removed; raw preserves brackets)', () => {
      const result = parseFolderStructureRaw(['Dune [Frank Herbert]']);
      expect(result.title).toBe('Dune [Frank Herbert]');
      expect(result.author).toBeNull();
    });

    it('returns raw "Title by Author" without cleaning', () => {
      const result = parseFolderStructureRaw(['Project Hail Mary by Andy Weir']);
      // parseSingleFolderRaw trims the by-match groups (same as cleaned parser guard logic)
      expect(result.title).toBe('Project Hail Mary');
      expect(result.author).toBe('Andy Weir');
    });

    it('returns raw title with no author when no pattern matches', () => {
      const result = parseFolderStructureRaw(['JustATitle MP3']);
      expect(result.title).toBe('JustATitle MP3');
      expect(result.author).toBeNull();
    });

    it('skips dash pattern when left is numeric (same as cleaned parser)', () => {
      const result = parseFolderStructureRaw(['01 - The Way of Kings']);
      // Numeric left skips dash match, falls through to "just a title"
      expect(result.title).toBe('01 - The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns raw Series–NN–Title for single segment', () => {
      const result = parseFolderStructureRaw(['Stormlight Archive - 1 - The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns raw 2-part Author/Title without cleaning', () => {
      const result = parseFolderStructureRaw(['Author Name', 'Title MP3']);
      expect(result.author).toBe('Author Name');
      expect(result.title).toBe('Title MP3');
      expect(result.series).toBeNull();
    });

    describe('audio extension stripping for single-file discoveries (issue #982)', () => {
      it('1-part: strips .m4b before raw parsing', () => {
        const result = parseFolderStructureRaw(['Doctor Sleep.m4b']);
        expect(result).toMatchObject({ title: 'Doctor Sleep', author: null });
      });

      it('1-part Author - Title.mp3 → raw author + title (extension stripped)', () => {
        const result = parseFolderStructureRaw(['Brandon Sanderson - The Way of Kings.mp3']);
        expect(result.author).toBe('Brandon Sanderson');
        expect(result.title).toBe('The Way of Kings');
      });

      it('2-part Author/Title.flac → raw author + title (extension stripped from title segment)', () => {
        const result = parseFolderStructureRaw(['Stephen King', 'Doctor Sleep.flac']);
        expect(result.author).toBe('Stephen King');
        expect(result.title).toBe('Doctor Sleep');
      });

      it('3-part last-segment .ogg extension stripped, intermediate segments untouched', () => {
        const result = parseFolderStructureRaw(['Author', 'Series', 'Title.ogg']);
        expect(result.title).toBe('Title');
        expect(result.series).toBe('Series');
        expect(result.author).toBe('Author');
      });
    });

    it('returns raw 2-part with Series–NN–Title in second segment', () => {
      const result = parseFolderStructureRaw(['Author', 'Series - 1 - Title']);
      expect(result.author).toBe('Author');
      expect(result.title).toBe('Title');
      expect(result.series).toBe('Series');
    });

    it('returns raw 3-part segments without cleaning', () => {
      const result = parseFolderStructureRaw(['Author MP3', 'Series (2020)', 'Title [GA]']);
      expect(result.author).toBe('Author MP3');
      expect(result.series).toBe('Series (2020)');
      expect(result.title).toBe('Title [GA]');
    });

    it('returns raw 4+ part segments using first/second-to-last/last', () => {
      const result = parseFolderStructureRaw(['Author', 'SubDir', 'Series', 'Title MP3']);
      expect(result.author).toBe('Author');
      expect(result.series).toBe('Series');
      expect(result.title).toBe('Title MP3');
    });

    describe('all-numeric date-like inputs (issue #701)', () => {
      it('1-part raw 11-22-63 keeps full value as title', () => {
        const result = parseFolderStructureRaw(['11-22-63']);
        expect(result.title).toBe('11-22-63');
        expect(result.author).toBeNull();
        expect(result.series).toBeNull();
      });

      it('1-part raw 11.22.63 keeps full value as title', () => {
        const result = parseFolderStructureRaw(['11.22.63']);
        expect(result.title).toBe('11.22.63');
        expect(result.series).toBeNull();
      });

      it('2-part raw Stephen King/11-22-63 → raw title=11-22-63, no series', () => {
        const result = parseFolderStructureRaw(['Stephen King', '11-22-63']);
        expect(result.author).toBe('Stephen King');
        expect(result.title).toBe('11-22-63');
        expect(result.series).toBeNull();
      });

      it('2-part raw Author/1.5 → raw title=1.5, no series', () => {
        const result = parseFolderStructureRaw(['Author', '1.5']);
        expect(result.author).toBe('Author');
        expect(result.title).toBe('1.5');
        expect(result.series).toBeNull();
      });

      it('2-part raw Author/Series - 1 - Title (real series) still split into series/title', () => {
        const result = parseFolderStructureRaw(['Author', 'Series - 1 - Title']);
        expect(result.series).toBe('Series');
        expect(result.title).toBe('Title');
      });
    });

    describe('targeted raw-mirror coverage (issue #980 review F3)', () => {
      it('raw P4: Discworld, Book 16 - Soul Music → raw series + seriesPosition + title (no narrator strip)', () => {
        const result = parseFolderStructureRaw(['Discworld, Book 16 - Soul Music (Read by Nigel Planer)']);
        expect(result.series).toBe('Discworld');
        expect(result.title).toBe('Soul Music (Read by Nigel Planer)');
        expect(result.seriesPosition).toBe(16);
        expect(result.author).toBeNull();
      });

      it('raw P4 first-dash guard: Author - Discworld, Book 16 - Soul Music does NOT match P4 (would have set series=`Author - Discworld`)', () => {
        const result = parseFolderStructureRaw(['Author - Discworld, Book 16 - Soul Music']);
        expect(result.author).toBe('Author');
        // P4 would have produced series=`Author - Discworld` and author=null. Confirm guard rejected.
        expect(result.series).not.toBe('Author - Discworld');
        // The dash heuristic + raw P10-postprocess produces a downstream parse;
        // the load-bearing assertion here is that the author is "Author" and P4 did not preempt.
      });

      it('raw P9: Liu, Cixin - Three Body 01 - Title (raw) → swapped author, raw P10-postprocess fires', () => {
        const result = parseFolderStructureRaw(['Liu, Cixin - Three Body 01 - The Three-Body Problem']);
        expect(result.author).toBe('Cixin Liu');
        expect(result.series).toBe('Three Body');
        expect(result.title).toBe('The Three-Body Problem');
        expect(result.seriesPosition).toBe(1);
      });

      it('raw P9: Asimov, Isaac - Foundation → swapped author, no series', () => {
        const result = parseFolderStructureRaw(['Asimov, Isaac - Foundation']);
        expect(result.author).toBe('Isaac Asimov');
        expect(result.title).toBe('Foundation');
      });

      it('raw P10-precheck: Murderbot Diaries 07 - System Collapse → series + position + title, author=null (raw)', () => {
        const result = parseFolderStructureRaw(['Murderbot Diaries 07 - System Collapse']);
        expect(result.series).toBe('Murderbot Diaries');
        expect(result.title).toBe('System Collapse');
        expect(result.seriesPosition).toBe(7);
        expect(result.author).toBeNull();
      });

      it('raw P10-postprocess: Martha Wells - Murderbot Diaries 07 - System Collapse → author + series + position', () => {
        const result = parseFolderStructureRaw(['Martha Wells - Murderbot Diaries 07 - System Collapse']);
        expect(result.author).toBe('Martha Wells');
        expect(result.series).toBe('Murderbot Diaries');
        expect(result.title).toBe('System Collapse');
        expect(result.seriesPosition).toBe(7);
      });

      it('raw P15: believe-me → author=null, series=null, raw title preserved', () => {
        const result = parseFolderStructureRaw(['believe-me']);
        expect(result.author).toBeNull();
        expect(result.series).toBeNull();
        expect(result.title).toBe('believe-me');
      });

      it('raw P15: dont-look-up → author=null, series=null', () => {
        const result = parseFolderStructureRaw(['dont-look-up']);
        expect(result.author).toBeNull();
        expect(result.series).toBeNull();
      });

      it('raw SERIES_NUMBER_TITLE: Series - 02 - Title (1-part) → series + position + title (issue #980 review F1)', () => {
        const result = parseFolderStructureRaw(['Stormlight Archive - 1 - The Way of Kings']);
        expect(result.series).toBe('Stormlight Archive');
        expect(result.title).toBe('The Way of Kings');
        expect(result.seriesPosition).toBe(1);
      });

      it('raw SERIES_NUMBER_TITLE: Author/Series - 02 - Title (2-part) → series + position + title (issue #980 review F1)', () => {
        const result = parseFolderStructureRaw(['Author', 'Series - 02 - Title']);
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
        expect(result.title).toBe('Title');
        expect(result.seriesPosition).toBe(2);
      });
    });

    describe('seriesPosition propagation in cleaned SERIES_NUMBER_TITLE branches (issue #980 review F1)', () => {
      it('1-part Stormlight Archive – 1 – The Way of Kings → seriesPosition=1', () => {
        const result = parseFolderStructure(['Stormlight Archive – 1 – The Way of Kings']);
        expect(result.seriesPosition).toBe(1);
      });

      it('2-part Author/Stormlight Archive - 1 - The Way of Kings → seriesPosition=1', () => {
        const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive - 1 - The Way of Kings']);
        expect(result.seriesPosition).toBe(1);
      });
    });

    describe('2-part P10 fallback for "Series NN - Title" / "Series - NN - Title" (issue #1016)', () => {
      it('cleaned: Sanderson / Mistborn 01 - The Final Empire (space-separated) → series + position + title', () => {
        const result = parseFolderStructure(['Sanderson', 'Mistborn 01 - The Final Empire']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });

      it('cleaned: Sanderson / Mistborn 01 - The Final Empire.mp3 (audio extension) → series + position + title', () => {
        const result = parseFolderStructure(['Sanderson', 'Mistborn 01 - The Final Empire.mp3']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });

      it('cleaned: Sanderson / Mistborn - 01 - The Final Empire (hyphenated) → series + position + title (existing SERIES_NUMBER branch)', () => {
        const result = parseFolderStructure(['Sanderson', 'Mistborn - 01 - The Final Empire']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });

      it('raw: Sanderson / Mistborn 01 - The Final Empire (space-separated) → series + position + title (uncleaned)', () => {
        const result = parseFolderStructureRaw(['Sanderson', 'Mistborn 01 - The Final Empire']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });

      it('raw: Sanderson / Mistborn 01 - The Final Empire.mp3 → series + position + title (extension stripped)', () => {
        const result = parseFolderStructureRaw(['Sanderson', 'Mistborn 01 - The Final Empire.mp3']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });

      it('raw: Sanderson / Mistborn - 01 - The Final Empire (hyphenated) → series + position + title (existing branch)', () => {
        const result = parseFolderStructureRaw(['Sanderson', 'Mistborn - 01 - The Final Empire']);
        expect(result).toEqual({
          author: 'Sanderson',
          series: 'Mistborn',
          seriesPosition: 1,
          title: 'The Final Empire',
        });
      });
    });

    describe('P4 first-dash guard (issue #980 review F2)', () => {
      it('cleaned: "Author - Discworld, Book 16 - Soul Music" does NOT match P4 (would have set series=`Author - Discworld`)', () => {
        const result = parseFolderStructure(['Author - Discworld, Book 16 - Soul Music']);
        // P4 without the guard would have returned series=`Author - Discworld`,
        // author=null, seriesPosition=16. With the guard it falls through to the
        // dash heuristic, which resolves author='Author'.
        expect(result.author).toBe('Author');
        expect(result.series).not.toBe('Author - Discworld');
      });
    });

    it('stays branch-aligned with cleaned parser for all patterns', () => {
      const cases: string[][] = [
        [],
        ['Author - Title'],
        ['Title (Author)'],
        ['Title [Author]'],
        ['Title by Author'],
        ['Series - 1 - Title'],
        ['JustATitle'],
        ['01 - Title'],
        ['11-22-63'],
        ['Author', 'Title'],
        ['Author', 'Series - 1 - Title'],
        ['Author', '11-22-63'],
        ['Author', 'Series', 'Title'],
        ['A', 'B', 'C', 'D'],
      ];
      for (const parts of cases) {
        const raw = parseFolderStructureRaw(parts);
        const cleaned = parseFolderStructure(parts);
        // Raw and cleaned must agree on which fields are null vs non-null
        expect(raw.title !== null).toBe(cleaned.title !== null);
        expect((raw.author !== null)).toBe((cleaned.author !== null));
        expect((raw.series !== null)).toBe((cleaned.series !== null));
      }
    });
  });

  describe('ASIN detection (issue #454)', () => {
    describe('extractASIN helper', () => {
      it('extracts ASIN and returns cleaned string', () => {
        const result = extractASIN('Title [B0D18DYG5C]');
        expect(result).toEqual({ asin: 'B0D18DYG5C', cleaned: 'Title' });
      });

      it('normalizes lowercase ASIN to uppercase', () => {
        const result = extractASIN('Title [b0d18dyg5c]');
        expect(result).toEqual({ asin: 'B0D18DYG5C', cleaned: 'Title' });
      });

      it('returns undefined asin when no match', () => {
        const result = extractASIN('Title [Author Name]');
        expect(result).toEqual({ asin: undefined, cleaned: 'Title [Author Name]' });
      });
    });

    describe('positive cases', () => {
      it('detects ASIN in "Title [B0D18DYG5C]" and does not treat as author', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C]']);
        expect(result.title).toBe('Title');
        expect(result.author).toBeNull();
        expect(result.asin).toBe('B0D18DYG5C');
      });

      it('detects ASIN with mixed alpha/numeric chars', () => {
        const result = parseFolderStructure(['Title [B0ABCDEF12]']);
        expect(result.asin).toBe('B0ABCDEF12');
        expect(result.title).toBe('Title');
      });

      it('normalizes lowercase ASIN to uppercase', () => {
        const result = parseFolderStructure(['Title [b0d18dyg5c]']);
        expect(result.asin).toBe('B0D18DYG5C');
      });

      it('extracts ASIN in 1-part path via parseFolderStructure', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBeNull();
      });

      it('extracts ASIN in 2-part path (exercises 2-part branch)', () => {
        const result = parseFolderStructure(['Author', 'Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
      });

      it('extracts ASIN in 3+-part path', () => {
        const result = parseFolderStructure(['Author', 'Series', 'Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
      });

      it('parseFolderStructureRaw returns ASIN in raw output with ASIN-stripped title', () => {
        const result = parseFolderStructureRaw(['Title MP3 [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        // Raw title is ASIN-stripped but NOT cleaned (MP3 remains)
        expect(result.title).toBe('Title MP3');
      });

      it('parseFolderStructureRaw extracts ASIN in 3-part path (raw author/series kept)', () => {
        const result = parseFolderStructureRaw(['Author MP3', 'Series (2020)', 'Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author MP3');
        expect(result.series).toBe('Series (2020)');
      });
    });

    describe('negative cases (no false positives)', () => {
      it('does not match [Author Name] as ASIN — bracket content is stripped, author=null (issue #977)', () => {
        const result = parseFolderStructure(['Dune [Frank Herbert]']);
        expect(result.asin).toBeUndefined();
        // Issue #977: bracket-as-author heuristic was removed; bracketTagStrip
        // step in cleanName removes the brackets, leaving title-only output.
        expect(result.author).toBeNull();
        expect(result.title).toBe('Dune');
      });

      it('does not match [2017] — year parsed normally', () => {
        const result = parseFolderStructure(['Title [2017]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [B0SHORT] — too few chars after B0', () => {
        const result = parseFolderStructure(['Title [B0SHORT]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [NOTASIN1234] — does not start with B0', () => {
        const result = parseFolderStructure(['Title [NOTASIN1234]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [B0TOOLONG123] — too many chars after B0', () => {
        const result = parseFolderStructure(['Title [B0TOOLONG123]']);
        expect(result.asin).toBeUndefined();
      });
    });

    describe('boundary values and edge cases', () => {
      it('folder name is ONLY the ASIN bracket — title falls back to original input', () => {
        const result = parseFolderStructure(['[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        // When stripped result is empty, should fall back
        expect(result.title).toBe('[B0D18DYG5C]');
      });

      it('ASIN in middle position — extracts ASIN, parses remainder', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C] Extra']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title Extra');
      });

      it('ASIN stripped before author-title split', () => {
        const result = parseFolderStructure(['Author - Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
      });

      it('multiple ASIN-like brackets — only first match extracted', () => {
        const result = parseFolderStructure(['Title [B0AAAAAAAA] [B0BBBBBBBB]']);
        expect(result.asin).toBe('B0AAAAAAAA');
      });

      it('ASIN-only segment in 2-part path — title falls back to original segment', () => {
        const result = parseFolderStructure(['Author', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
        expect(result.author).toBe('Author');
      });

      it('ASIN-only segment in 3+-part path — title falls back to original segment', () => {
        const result = parseFolderStructure(['Author', 'Series', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
      });

      it('ASIN-only segment in 2-part raw path — title falls back to original', () => {
        const result = parseFolderStructureRaw(['Author', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
      });

      it('extractYear not affected by ASIN brackets', () => {
        expect(extractYear('Title [B0D18DYG5C]')).toBeUndefined();
      });
    });
  });

  describe('extraction integrity', () => {
    it('parseFolderStructure returns identical results after extraction', () => {
      // Same test cases from library-scan.service.test.ts. The 'Title (Author)'
      // case was updated for issue #977: parens-as-author heuristic removed, so
      // parens content is stripped by NARRATOR_PAREN_REGEX with author=null.
      const cases: [string[], { title: string; author: string | null; series: string | null }][] = [
        [['Author', 'Title'], { title: 'Title', author: 'Author', series: null }],
        [['Author', 'Series', 'Title'], { title: 'Title', author: 'Author', series: 'Series' }],
        [['Author - Title'], { title: 'Title', author: 'Author', series: null }],
        [['Title (Author)'], { title: 'Title', author: null, series: null }],
        [[], { title: 'Unknown', author: null, series: null }],
      ];
      for (const [parts, expected] of cases) {
        expect(parseFolderStructure(parts)).toEqual(expected);
      }
    });

    it('cleanName transformation order is preserved', () => {
      // Series markers before dedup
      expect(cleanName('Title, Book 01 – Title')).toBe('Title');
      // Leading numeric before everything
      expect(cleanName('01 - Title')).toBe('Title');
    });

    it('extractYear works identically after extraction', () => {
      expect(extractYear('Title (2020)')).toBe(2020);
      expect(extractYear('Title [2019]')).toBe(2019);
      expect(extractYear('Title 2017')).toBe(2017);
      expect(extractYear('No Year')).toBeUndefined();
    });
  });

  describe('CODEC_TEST_REGEX (non-global codec guard)', () => {
    it('does not have the global flag', () => {
      expect(CODEC_TEST_REGEX.global).toBe(false);
    });

    it('matches each codec tag: MP3, M4B, M4A, FLAC, OGG, AAC, Unabridged, Abridged', () => {
      for (const tag of ['MP3', 'M4B', 'M4A', 'FLAC', 'OGG', 'AAC', 'Unabridged', 'Abridged']) {
        expect(CODEC_TEST_REGEX.test(tag)).toBe(true);
      }
    });

    it('rejects non-codec content', () => {
      expect(CODEC_TEST_REGEX.test('Jeff Hays')).toBe(false);
      expect(CODEC_TEST_REGEX.test('Ray Porter')).toBe(false);
      expect(CODEC_TEST_REGEX.test('Some Title')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(CODEC_TEST_REGEX.test('mp3')).toBe(true);
      expect(CODEC_TEST_REGEX.test('Flac')).toBe(true);
      expect(CODEC_TEST_REGEX.test('aac')).toBe(true);
    });

    it('returns consistent results on consecutive .test() calls (no lastIndex drift)', () => {
      expect(CODEC_TEST_REGEX.test('MP3')).toBe(true);
      expect(CODEC_TEST_REGEX.test('MP3')).toBe(true);
      expect(CODEC_TEST_REGEX.test('MP3')).toBe(true);
    });
  });

  describe('cleanName consecutive calls (lastIndex hardening)', () => {
    it('consecutive calls with narrator parens both strip correctly', () => {
      const first = cleanName('Title (Jeff Hays)');
      const second = cleanName('Other Title (Ray Porter)');
      expect(first).toBe('Title');
      expect(second).toBe('Other Title');
    });

    it('input with no parens does not affect subsequent calls', () => {
      const first = cleanName('Plain Title');
      const second = cleanName('Another Title (Jeff Hays)');
      expect(first).toBe('Plain Title');
      expect(second).toBe('Another Title');
    });

    it('input with codec tag in name itself still strips narrator paren', () => {
      const result = cleanName('Title MP3 (Jeff Hays)');
      expect(result).toBe('Title');
    });
  });

  describe('cleanNameWithTrace consecutive calls (lastIndex hardening)', () => {
    it('consecutive trace calls with narrator parens both strip correctly', () => {
      const first = cleanNameWithTrace('Title (Jeff Hays)');
      const second = cleanNameWithTrace('Other Title (Ray Porter)');
      expect(first.result).toBe('Title');
      expect(second.result).toBe('Other Title');
    });
  });

  describe('mixed cleanName/cleanNameWithTrace calls (shared regex state)', () => {
    it('cleanName then cleanNameWithTrace produces correct results', () => {
      const name = cleanName('Title (Jeff Hays)');
      const trace = cleanNameWithTrace('Other Title (Ray Porter)');
      expect(name).toBe('Title');
      expect(trace.result).toBe('Other Title');
    });
  });

  describe('cleanTagTitle (#1007)', () => {
    it('preserves colon-subtitle (no colon-strip rule)', () => {
      expect(cleanTagTitle('The Sandman: Act II')).toBe('The Sandman: Act II');
      expect(cleanTagTitle('Mistborn: The Final Empire')).toBe('Mistborn: The Final Empire');
    });

    it('preserves multi-colon nested-series form (Jaina double-colon)', () => {
      expect(cleanTagTitle('World of Warcraft: Jaina Proudmoore: Tides of War')).toBe(
        'World of Warcraft: Jaina Proudmoore: Tides of War',
      );
    });

    it('preserves dots — Audible title= param is dot-sensitive', () => {
      expect(cleanTagTitle('World War 3.1')).toBe('World War 3.1');
    });

    it('preserves initials and colon together', () => {
      expect(cleanTagTitle('M. O. Walsh: The Big Door Prize')).toBe('M. O. Walsh: The Big Door Prize');
    });

    it('strips comma-prefixed series marker `, Book N`', () => {
      expect(cleanTagTitle('Eric: Discworld, Book 9')).toBe('Eric: Discworld');
    });

    it('strips dash-form series marker — preserves dash separator', () => {
      expect(cleanTagTitle('Imagine Me - Shatter Me Series, Book 6')).toBe('Imagine Me - Shatter Me Series');
    });

    it('strips space-prefixed `trilogy book N` form', () => {
      expect(cleanTagTitle('The Final Empire Mistborn trilogy book 1')).toBe('The Final Empire Mistborn');
    });

    it('strips `(Unabridged)` paren before series marker so anchored regex matches', () => {
      expect(cleanTagTitle('Zero Hour: Expeditionary Force, Book 5 (Unabridged)')).toBe('Zero Hour: Expeditionary Force');
    });

    it('strips bracket tags', () => {
      expect(cleanTagTitle('The Atlantis Gene [Dramatized Adaptation]')).toBe('The Atlantis Gene');
    });

    it('preserves bare-year paren — NARRATOR_PAREN_REGEX lookahead excludes (YYYY)', () => {
      expect(cleanTagTitle('Brave New World (2006)')).toBe('Brave New World (2006)');
    });

    it('preserves year-prefix edition paren', () => {
      expect(cleanTagTitle('World War Z (2006 Edition)')).toBe('World War Z (2006 Edition)');
    });

    it('preserves ordinal-prefix edition paren', () => {
      expect(cleanTagTitle('The Stand (10th Anniversary Edition)')).toBe('The Stand (10th Anniversary Edition)');
    });

    it('preserves edition-keyword paren', () => {
      expect(cleanTagTitle('Some Title (Special Edition)')).toBe('Some Title (Special Edition)');
    });

    it('strips narrator paren (not an edition)', () => {
      expect(cleanTagTitle('Title (William Hope)')).toBe('Title');
    });

    it('preserves all-numeric date-like input', () => {
      expect(cleanTagTitle('11-22-63')).toBe('11-22-63');
    });

    it('preserves kebab-case slug input', () => {
      expect(cleanTagTitle('believe-me')).toBe('believe-me');
    });

    it('returns empty for empty input', () => {
      expect(cleanTagTitle('')).toBe('');
    });

    it('falls back to original on whitespace-only input (intermediate result empties)', () => {
      // Bracket-strip + trim drops whitespace-only to ''; series-marker no-op; `result || s` returns the original.
      expect(cleanTagTitle('   ')).toBe('   ');
    });

    it('does not strip "Book N" without leading separator (regex requires [\\s,]+)', () => {
      expect(cleanTagTitle('Book 1')).toBe('Book 1');
    });

    it('does not strip a trailing digit alone — series-marker requires book/vol keyword', () => {
      expect(cleanTagTitle('World War 3')).toBe('World War 3');
    });

    it('same-prefix volume disambiguation — Acts stay distinct', () => {
      expect(cleanTagTitle('The Sandman: Act I')).toBe('The Sandman: Act I');
      expect(cleanTagTitle('The Sandman: Act II')).toBe('The Sandman: Act II');
      expect(cleanTagTitle('The Sandman: Act III')).toBe('The Sandman: Act III');
    });
  });

  describe('rapid consecutive calls (stress)', () => {
    it('5+ sequential cleanName calls with narrator parens all produce correct results', () => {
      const inputs = [
        'Title One (Jeff Hays)',
        'Title Two (Ray Porter)',
        'Title Three (Scott Brick)',
        'Title Four (Jim Dale)',
        'Title Five (Stephen Fry)',
      ];
      const expected = ['Title One', 'Title Two', 'Title Three', 'Title Four', 'Title Five'];
      for (let i = 0; i < inputs.length; i++) {
        expect(cleanName(inputs[i]!)).toBe(expected[i]);
      }
    });

    it('trace results match cleanName results for same inputs', () => {
      const inputs = [
        'Title One (Jeff Hays)',
        'Title Two (Ray Porter)',
        'Title Three (Scott Brick)',
      ];
      for (const input of inputs) {
        expect(cleanNameWithTrace(input).result).toBe(cleanName(input));
      }
    });
  });
});
