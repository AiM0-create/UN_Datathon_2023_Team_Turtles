var table = ee.FeatureCollection("projects/ee-emergencycase19/assets/Datathon/Delhi");

// AOI
Map.centerObject(table,8);
var regionInt = table;

function waterMask(img) {
  var water=ee.Image('JRC/GSW1_0/GlobalSurfaceWater').select(
  'occurrence');
  var notWater=water.mask().not();
  return img.updateMask(notWater);
}

// Select region of interest, date range.
var geometry=regionInt.geometry();
var dateStart=ee.Date('2018-01-01');
var dateEnd=ee.Date('2023-12-31');


var dataset = ee.ImageCollection('COPERNICUS/S5P/NRTI/L3_harmonicNO2')
    .filterDate(dateStart, dateEnd)
    .filterBounds(table)
    .map(function(img){return img.clip(table)});

// print(dataset, '1');

var noColl = dataset.select('NO2_column_number_density');

// print(noColl, '2');

// Create composite, mask, and set date, month & year.
var noComp=noColl
.select('NO2_column_number_density')
.map(waterMask)
.map(function(feat){
  var dateString = feat.getString('system:index');
  var year = ee.Number.parse(dateString.slice(0,4));
  var month = ee.Number.parse(dateString.slice(4,6));
  var day = ee.Number.parse(dateString.slice(6,8));
  var date = ee.Number.parse(dateString.slice(0,8));
  return feat.set('date', date, 'year', year, 'month', month, 'day', day);
});



// print(noComp, '3');

//create list of months from April to July
var months = ee.List.sequence(4, 7);

//separate by years
var years = ee.List.sequence(dateStart.get('year'), dateEnd.get('year'));
// print(years, '2');

//compute NO2_column_number_density value per month

var composite = years.map(function (y) {
  return noComp.filter(ee.Filter.eq('year', y)).median().set('year',y);
});
// print(composite, 'x');

var list_imgs = composite.flatten();

// print(list_imgs, 'im');
//set system id and system index according to year
function renameImages(img1) {
  var img = ee.Image(img1);
  var value = ee.Number(img.get('year')).format('%04d');
  return ee.Image(img.set('system:index', value, 'system:id',value));
}
var list_imgs_renamed = list_imgs.map(renameImages);

//convert from list to img collection
var decomposed_collection = ee.ImageCollection(list_imgs_renamed);



////////////////////////////////////////////////////////////////
//Gap filling using historic data

//set image dates in milliseconds
function setTime(img) {
  return img.set('system:time_start', ee.Date.fromYMD(
                  img.get('year'),05,01).millis());
}
//set number of bands
function addNumBands(img){
  return img.set('num_bands', img.bandNames().length());
}
//add time band to image
function addTime(img) {
  var time = ee.Image(img.date().millis()).rename('t').float();
  return img.addBands(time);
}
//add constant band
function addConstant(img) {
  return img.addBands(ee.Image.constant(1));
}
//apply functions
var decomposed_collection =  decomposed_collection.map(addNumBands);

var decomposed_collection = decomposed_collection
                                       .filter('num_bands > 0');

var decomposed_collection =  decomposed_collection.map(setTime);

var decomposed_collection =  decomposed_collection.map(addConstant);

var decomposed_collection =  decomposed_collection.map(addTime);

// define the dependent variable to be modeled.
var dependent = 'NO2_column_number_density';

// define the number of cycles per year to model.
var harmonics = 3;

// make a list of harmonic frequencies to model,  
// which also serve as band name suffixes.
var harmonicFrequencies = ee.List.sequence(1, harmonics);

// get a sequence of band names for harmonic terms.
var getNames = function(base, list) {
  return ee.List(list).map(function(i) { 
    return ee.String(base).cat(ee.Number(i).int());
  });
};

// create lists of names for the harmonic terms.
var cosNames = getNames('cos_', harmonicFrequencies);

var sinNames = getNames('sin_', harmonicFrequencies);

// define independent variables.
var independents = ee.List(['constant', 't'])
                            .cat(cosNames).cat(sinNames);
                            
// compute the specified number of harmonics
// and add them as bands. Assumes the time band is present.
var addHarmonics = function(freqs) {
  return function(image) {
    // make an image of frequencies
    var frequencies = ee.Image.constant(freqs);
    // this band should represent time in radians.
    var PI2 = 2.0 * Math.PI;
    var time = ee.Image(image).select('t').multiply( PI2 / (1000 * 60 * 60 * 24 * 365.25));
    // get the cosine terms.
    var cosines = time.multiply(frequencies).cos().rename(cosNames); 
    // get the sin terms.
    var sines = time.multiply(frequencies).sin().rename(sinNames);
    return image.addBands(cosines).addBands(sines);
  };
};

// Add variables.
var harmonicNO = decomposed_collection.map(
                                addHarmonics(harmonicFrequencies));
                                
// print(harmonicNO, '5');


// fit model to time-series using linear regression reducer
var harmonicTrend = harmonicNO
   .select(independents.add(dependent))
   .reduce(ee.Reducer.linearRegression({
        numX: independents.length(),
        numY: 1}));
        
// turn the array image into a multi-band image of coefficients.
var harmonicTrendCoefficients = harmonicTrend.select('coefficients')
   .arrayProject([0])
   .arrayFlatten([independents]);
   
// compute fitted values.
var fittedHarmonic = harmonicNO.map(function(image) {
   return image.addBands(image.select(independents)
        .multiply(harmonicTrendCoefficients)
        .reduce('sum')
        .rename('fitted'));
});

//get original composite values
var original_NO = decomposed_collection.select('NO2_column_number_density');

//get fitted NO values
var fitted_NO = fittedHarmonic.select('fitted');

//combine bands
var combined = original_NO.combine(fitted_NO);

//fill gaps in original with fitted values
var gap_filled_composite = combined.map(function(img){
            return img.select('NO2_column_number_density').unmask(img.select('fitted'));
});

//filter by date
var gap_filled_composite = gap_filled_composite
                                 .filterDate(dateStart, dateEnd);


// print(gap_filled_composite, '6');

////////////////////////////////////////////////////////////////

//convert from img collection to multi-band single image
var singleBand = gap_filled_composite.toBands();
//add august composite to map
Map.addLayer(singleBand,{bands: '2019_NO2_column_number_density', min: 0, max: 0.0002,
                       palette: ['black', 'blue', 'purple', 'cyan', 'green', 'yellow', 'red']}, 'NO year');
                       
                      

// print(decomposed_collection, '3');
Map.addLayer(decomposed_collection,{
      min: 0,
      max: 0.0002,
      // palette: ['blue', 'white', 'red']
  },'NO_SMW');
   

/////////////////////////////////////////////////////////////////////

// Batch export the collection to earth engine asset

var batch = require('users/fitoprincipe/geetools:batch');
batch.Download.ImageCollection.toAsset(gap_filled_composite, 'NO_Delhi', 
                {scale: 1000, 
                region: table,
                type: 'float'});

// Batch export the collection to earth engine asset

var batch = require('users/fitoprincipe/geetools:batch');
batch.Download.ImageCollection.toDrive(gap_filled_composite, 'NO_Delhi', 
                {scale: 1000, 
                region: table,
                type: 'float'});