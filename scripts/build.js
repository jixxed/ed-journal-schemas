const fs = require('fs-extra');
const path = require('path');
const Handlebars = require('handlebars');
const marked = require('marked');
const lunr = require('lunr');
const sass = require('sass');

console.log('Starting build process...');

// Configuration
const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

console.log('Directories:');
console.log('- Schemas:', SCHEMAS_DIR);
console.log('- Dist:', DIST_DIR);
console.log('- Templates:', TEMPLATES_DIR);

// Ensure dist directory exists
fs.ensureDirSync(DIST_DIR);
console.log('Created dist directory');

// Register Handlebars helper for JSON stringification
Handlebars.registerHelper('json', function(context) {
    return JSON.stringify(context);
});
console.log('Registered Handlebars helpers');

try {
    // Load templates
    console.log('Loading templates...');
    const indexTemplate = Handlebars.compile(fs.readFileSync(path.join(TEMPLATES_DIR, 'index.hbs'), 'utf8'));
    const eventTemplate = Handlebars.compile(fs.readFileSync(path.join(TEMPLATES_DIR, 'event.hbs'), 'utf8'));
    console.log('Templates loaded successfully');

    // Process SCSS
    console.log('Processing SCSS...');
    const result = sass.compile(path.join(__dirname, '..', 'src', 'styles.scss'));
    fs.writeFileSync(path.join(DIST_DIR, 'styles.css'), result.css);
    console.log('SCSS processed successfully');

    // Recursive function to process properties
    function processProperties(properties, required = [], path = '', definitions = {}) {
        const result = [];
        
        for (const [key, value] of Object.entries(properties || {})) {
            const currentPath = path ? `${path}.${key}` : key;
            const isRequired = required.includes(key);
            const displayName = key; // Use just the key name for display
            
            // Handle $ref to definitions
            if (value.$ref) {
                const refPath = value.$ref.replace('#/definitions/', '');
                const definition = definitions[refPath];
                if (definition) {
                    result.push({
                        name: displayName,
                        type: definition.type || 'object',
                        description: definition.description || '',
                        optional: !isRequired,
                        examples: definition.examples || [],
                        properties: processProperties(definition.properties || {}, definition.required || [], currentPath, definitions)
                    });
                    continue;
                }
            }
            
            if (value.type === 'object' && value.properties) {
                // Handle nested object
                result.push({
                    name: displayName,
                    type: 'object',
                    description: value.description || '',
                    optional: !isRequired,
                    examples: value.examples || [],
                    properties: processProperties(value.properties, value.required || [], currentPath, definitions)
                });
            } else if (value.type === 'array' && value.items) {
                // Handle array type
                if (value.items.$ref) {
                    const refPath = value.items.$ref.replace('#/definitions/', '');
                    const definition = definitions[refPath];
                    if (definition) {
                        result.push({
                            name: displayName,
                            type: 'array',
                            description: value.description || '',
                            optional: !isRequired,
                            examples: value.examples || [],
                            properties: processProperties(definition.properties || {}, definition.required || [], currentPath, definitions)
                        });
                        continue;
                    }
                }
                if (value.items.type === 'object' && value.items.properties) {
                    result.push({
                        name: displayName,
                        type: 'array',
                        description: value.description || '',
                        optional: !isRequired,
                        examples: value.examples || [],
                        properties: processProperties(value.items.properties, value.items.required || [], currentPath, definitions)
                    });
                } else {
                    result.push({
                        name: displayName,
                        type: `array<${value.items.type}>`,
                        description: value.description || '',
                        optional: !isRequired,
                        examples: value.examples || []
                    });
                }
            } else {
                // Handle simple types
                result.push({
                    name: displayName,
                    type: value.type || 'unknown',
                    description: value.description || '',
                    optional: !isRequired,
                    examples: value.examples || []
                });
            }
        }
        
        return result;
    }

    // Helper function to get all schema files
    function getSchemaFiles() {
        console.log('Getting schema files...');
        const schemaFiles = [];
        const dirs = fs.readdirSync(SCHEMAS_DIR);
        console.log(`Found ${dirs.length} directories in schemas folder`);
        
        for (const dir of dirs) {
            const schemaPath = path.join(SCHEMAS_DIR, dir, `${dir}.json`);
            if (fs.existsSync(schemaPath)) {
                schemaFiles.push({
                    name: dir,
                    path: schemaPath
                });
            }
        }
        
        console.log(`Found ${schemaFiles.length} schema files`);
        return schemaFiles;
    }

    // Helper function to process a schema file
    function processSchema(schemaPath) {
        console.log(`Processing schema: ${schemaPath}`);
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        const eventName = path.basename(path.dirname(schemaPath));
        
        // Load and process the base Event schema
        const baseEventPath = path.join(SCHEMAS_DIR, '_Event.json');
        const baseEvent = JSON.parse(fs.readFileSync(baseEventPath, 'utf8'));
        
        // Process base event properties first
        const baseProperties = processProperties(baseEvent.properties || {}, baseEvent.required || []);
        
        // Process the event's own properties, including definitions
        const eventProperties = processProperties(schema.properties || {}, schema.required || [], '', schema.definitions || {});
        
        // Combine properties, putting base properties first
        const allProperties = [...baseProperties, ...eventProperties];
        
        // Find and update the event field
        const eventFieldIndex = allProperties.findIndex(prop => prop.name === 'event');
        if (eventFieldIndex !== -1) {
            allProperties[eventFieldIndex].examples = [eventName];
        }
        
        const processedSchema = {
            name: eventName,
            description: schema.description || '',
            properties: allProperties
        };
        
        // Debug logging
        console.log(`Final processed schema for ${eventName}:`, JSON.stringify(processedSchema, null, 2));
        
        return processedSchema;
    }

    // Build the search index
    function buildSearchIndex(events) {
        console.log('Building search index...');
        const idx = lunr(function () {
            this.ref('name');
            this.field('name', { boost: 10 });
            this.field('description', { boost: 5 });
            this.field('properties', { boost: 3 });
            this.field('propertyDescriptions', { boost: 2 });
            
            // Enable partial word matching
            this.pipeline.remove(lunr.stemmer);
            this.pipeline.remove(lunr.stopWordFilter);
            
            events.forEach(event => {
                // Collect all property names and descriptions
                const propertyNames = [];
                const propertyDescriptions = [];
                
                function collectProperties(props) {
                    for (const prop of props) {
                        propertyNames.push(prop.name);
                        if (prop.description) {
                            propertyDescriptions.push(prop.description);
                        }
                        if (prop.properties) {
                            collectProperties(prop.properties);
                        }
                    }
                }
                
                collectProperties(event.properties);
                
                // Add the event to the index
                this.add({
                    name: event.name.toLowerCase(),
                    description: event.description.toLowerCase(),
                    properties: propertyNames.join(' ').toLowerCase(),
                    propertyDescriptions: propertyDescriptions.join(' ').toLowerCase()
                });
            });
        });
        
        console.log('Search index built successfully');
        return idx;
    }

    // Main build function
    async function build() {
        console.log('Starting main build process...');
        
        // Get all schema files
        const schemaFiles = getSchemaFiles();
        
        // Process all schemas
        console.log('Processing schemas...');
        const events = schemaFiles.map(file => processSchema(file.path));
        console.log(`Processed ${events.length} events`);
        
        // Build search index
        const searchIndex = buildSearchIndex(events);
        
        // Generate index page
        console.log('Generating index page...');
        const indexHtml = indexTemplate({
            events,
            searchIndex: JSON.stringify(searchIndex)
        });
        await fs.writeFile(path.join(DIST_DIR, 'index.html'), indexHtml);
        console.log('Index page generated');
        
        // Generate event pages
        console.log('Generating event pages...');
        for (const event of events) {
            const eventHtml = eventTemplate(event);
            await fs.writeFile(path.join(DIST_DIR, `${event.name}.html`), eventHtml);
        }
        console.log('Event pages generated');
        
        // Copy static assets
        console.log('Copying static assets...');
        const assetsSrc = path.join(__dirname, '..', 'src', 'assets');
        const assetsDist = path.join(DIST_DIR, 'assets');
        
        if (fs.existsSync(assetsSrc)) {
            await fs.copy(assetsSrc, assetsDist);
            console.log('Static assets copied');
        } else {
            console.log('No assets directory found, skipping asset copy');
            fs.ensureDirSync(assetsDist);
        }
        
        // Write styles
        await fs.writeFile(path.join(DIST_DIR, 'styles.css'), result.css);
        console.log('Styles written');
        
        console.log('Build completed successfully!');
    }

    // Watch mode
    if (process.argv.includes('--watch')) {
        const chokidar = require('chokidar');
        
        chokidar.watch([
            SCHEMAS_DIR,
            path.join(__dirname, '..', 'src'),
            path.join(__dirname, '..', 'templates')
        ]).on('change', async () => {
            console.log('Changes detected, rebuilding...');
            await build();
        });
        
        console.log('Watching for changes...');
        build().catch(error => {
            console.error('Build failed with error:', error);
            process.exit(1);
        });
    } else {
        build().catch(error => {
            console.error('Build failed with error:', error);
            process.exit(1);
        });
    }
} catch (error) {
    console.error('Build failed with error:', error);
    process.exit(1);
} 