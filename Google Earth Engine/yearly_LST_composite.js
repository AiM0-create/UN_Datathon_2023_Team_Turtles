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

// Link to the module that computes the Landsat LST.
var landsatLST=require(
   'projects/gee-edu/book:Part A - Applications/A1 - Human Applications/A1.5 Heat Islands/modules/Landsat_LST.js');

// Select region of interest, date range, and Landsat satellite.
var geometry=regionInt.geometry();
var satellite='L8';
var dateStart=ee.Date('2018-01-01');
var dateEnd=ee.Date('2023-12-31');
var useNdvi=true;

// Applies scaling factors.
function applyScaleFactors(image) {
  var opticalBands = image.select('SR_B.').multiply(0.0000275).add(-0.2);
  var thermalBands = image.select('ST_B.*').multiply(0.00341802).add(149.0);
  return image.addBands(opticalBands, null, true)
              .addBands(thermalBands, null, true);
}

// Get Landsat collection with additional necessary variables.
var landsatColl=landsatLST.collection(satellite, dateStart, dateEnd,
   geometry, useNdvi);
   
// print(landsatColl, '1');

// Create composite, clip, mask, convert to degree Celsius and set day, month and year.
var landsatComp=landsatColl
.select('LST')
.map(function(img){return img.clip(table)})
.map(waterMask)
.map(function(img){return img.subtract(273.15)})
.map(function(feat){
  var dateString = feat.getString('system:index');
  var year = ee.Number.parse(dateString.slice(12,16));
  var month = ee.Number.parse(dateString.slice(16,18));
  var day = ee.Number.parse(dateString.slice(18,20));
  var date = dateString.split('_').get(2);
  return feat.set('date', date, 'year', year, 'month', month, 'day', day);
});


// print(landsatComp, '2');

//create list of months from April to July.
var months = ee.List.sequence(4, 7);

//separate by years
var years = ee.List.sequence(dateStart.get('year'), dateEnd.get('year'));

// print(years, '3');

//compute mean value per month

var composite = years.map(function (y) {
  return landsatComp.filter(ee.Filter.eq('year', y)).mean().set('year',y);
});
// print(composite, 'x');

var list_imgs = composite.flatten();

// print(list_imgs, 'im');
//set system id and system index according to year and month
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
var dependent = 'LST';

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
var harmonicLST = decomposed_collection.map(
                                addHarmonics(harmonicFrequencies));
                                
// print(harmonicLST, '5');


// fit model to time-series using linear regression reducer
var harmonicTrend = harmonicLST
   .select(independents.add(dependent))
   .reduce(ee.Reducer.linearRegression({
        numX: independents.length(),
        numY: 1}));
        
// turn the array image into a multi-band image of coefficients.
var harmonicTrendCoefficients = harmonicTrend.select('coefficients')
   .arrayProject([0])
   .arrayFlatten([independents]);
   
// LSTmpute fitted values.
var fittedHarmonic = harmonicLST.map(function(image) {
   return image.addBands(image.select(independents)
        .multiply(harmonicTrendCoefficients)
        .reduce('sum')
        .rename('fitted'));
});

//get original composite values
var original_LST = decomposed_collection.select('LST');

//get fitted LST values
var fitted_LST = fittedHarmonic.select('fitted');

//combine bands
var combined = original_LST.combine(fitted_LST);

//fill gaps in original with fitted values
var gap_filled_composite = combined.map(function(img){
            return img.select('LST').unmask(img.select('fitted'));
});

//filter by date
var gap_filled_composite = gap_filled_composite
                                 .filterDate(dateStart, dateEnd);


// print(gap_filled_composite, '6');

////////////////////////////////////////////////////////////////

//convert from img collection to multi-band single image
var singleBand = gap_filled_composite.toBands();
//add august composite to map
Map.addLayer(singleBand,{bands: '2021_LST', min: 10, max: 50,
                       palette: ['blue', 'white', 'red']}, 'LST year');
                       
                      

// print(decomposed_collection, '3');
Map.addLayer(decomposed_collection,{
      min: 10,
      max: 50,
      // palette: ['blue', 'white', 'red']
  },'LST_SMW');
   

/////////////////////////////////////////////////////////////////////

// Batch export the collection to earth engine asset

var batch = require('users/fitoprincipe/geetools:batch');
batch.Download.ImageCollection.toAsset(gap_filled_composite, 'LST_Delhi', 
                {scale: 30, 
                region: table,
                type: 'float'});

// Batch export the collection to earth engine asset

var batch = require('users/fitoprincipe/geetools:batch');
batch.Download.ImageCollection.toDrive(gap_filled_composite, 'LST_Delhi', 
                {scale: 30, 
                region: table,
                type: 'float'});